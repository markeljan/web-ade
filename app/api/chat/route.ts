import { pipeJsonRender } from '@json-render/core';
import { Redis } from '@upstash/redis';
import { metric } from '@vercel/functions';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  streamText,
  type UIMessage,
  type UIMessageChunk,
  validateUIMessages,
} from 'ai';
import { after, NextResponse } from 'next/server';
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
  type Subscriber,
} from 'resumable-stream/generic';
import { invalidateVercelGatewayCreditsCache, isUserTokenBillingError } from '@/lib/ai/credits';
import { estimateTokenCostUsd } from '@/lib/ai/models';
import {
  ProviderNotConfiguredError,
  type ProviderOverrideInput,
  resolveFastLanguageModel,
  resolveLanguageModel,
  type UserVercelAuth,
} from '@/lib/ai/provider';
import { buildAdeSystemPrompt } from '@/lib/ai/system-prompt';
import { createAdeTools } from '@/lib/ai/tools/index';
import { getServerSession, updateVercelTokens } from '@/lib/auth/session';
import { ensureChat, getChatById, saveMessages, updateChat } from '@/lib/db/queries';
import { getActiveTier, listFiles } from '@/lib/sandbox/manager';
import type { ChatRequestBody, MessageMetadata, SandboxTier, TokenUsageSummary } from '@/lib/types';
import { generateId, truncateText } from '@/lib/utils';

export const maxDuration = 300;

interface ExtendedChatRequestBody extends ChatRequestBody {
  sandboxTier?: SandboxTier;
  customBaseUrl?: string;
  customApiKey?: string;
  customModel?: string;
  byokApiKey?: string;
  githubToken?: string;
  uiActRequireApproval?: boolean;
}

interface ResumableBusState {
  context?: ResumableStreamContext;
  listeners?: Map<string, Set<(message: string) => void>>;
}

const globalResumable = globalThis as typeof globalThis & {
  __webAdeResumable?: ResumableBusState;
};

function getOptionalResumableContext(): ResumableStreamContext | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    return null;
  }

  if (!globalResumable.__webAdeResumable) {
    globalResumable.__webAdeResumable = { listeners: new Map() };
  }

  if (globalResumable.__webAdeResumable.context) {
    return globalResumable.__webAdeResumable.context;
  }

  const redis = new Redis({ url, token });
  const listeners = globalResumable.__webAdeResumable.listeners ?? new Map();
  globalResumable.__webAdeResumable.listeners = listeners;

  const publisher: Publisher = {
    connect: async () => undefined,
    publish: async (channel, message) => {
      const subs = listeners.get(channel);
      if (subs) {
        for (const cb of subs) {
          cb(message);
        }
      }
      return subs?.size ?? 0;
    },
    set: async (key, value, options) => {
      if (options?.EX) {
        return redis.set(key, value, { ex: options.EX });
      }
      return redis.set(key, value);
    },
    get: async (key) => {
      const value = await redis.get<string | number | null>(key);
      return value ?? null;
    },
    incr: async (key) => redis.incr(key),
  };

  const subscriber: Subscriber = {
    connect: async () => undefined,
    subscribe: async (channel, callback) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(callback);
    },
    unsubscribe: async (channel) => {
      listeners.delete(channel);
    },
  };

  const context = createResumableStreamContext({
    keyPrefix: 'web-ade:stream',
    waitUntil: after,
    publisher,
    subscriber,
  });

  globalResumable.__webAdeResumable.context = context;
  return context;
}

function mergeProviderOverride(body: ExtendedChatRequestBody): ProviderOverrideInput | undefined {
  const base = body.providerOverride ?? {};
  const merged: ProviderOverrideInput = {
    ...base,
    ...(body.customBaseUrl ? { customBaseUrl: body.customBaseUrl } : {}),
    ...(body.customApiKey ? { customApiKey: body.customApiKey } : {}),
    ...(body.customModel ? { customModel: body.customModel } : {}),
    ...(body.byokApiKey ? { byokApiKey: body.byokApiKey } : {}),
    ...(body.githubToken ? { githubToken: body.githubToken } : {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function extractFirstUserText(messages: UIMessage<MessageMetadata>[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const part of msg.parts) {
      if (part.type === 'text' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return '';
}

function buildUsageSummary(
  modelId: string,
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  },
): TokenUsageSummary | undefined {
  if (!totalUsage) {
    return undefined;
  }
  const inputTokens = totalUsage.inputTokens ?? 0;
  const outputTokens = totalUsage.outputTokens ?? 0;
  const totalTokens = totalUsage.totalTokens ?? inputTokens + outputTokens;
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: totalUsage.outputTokenDetails?.reasoningTokens,
    cacheReadTokens: totalUsage.inputTokenDetails?.cacheReadTokens,
    estimatedCostUsd: estimateTokenCostUsd(modelId, inputTokens, outputTokens),
  };
}

function isErrorChunkWithUserBillingFailure(chunk: UIMessageChunk): boolean {
  if (chunk.type !== 'error') {
    return false;
  }
  return isUserTokenBillingError(chunk.errorText);
}

/**
 * Streams a `streamText` UI stream while buffering only until the first meaningful
 * chunk arrives. If a Tier-2 Vercel OAuth token fails with 401/402/403 before output
 * begins, returns `{ retryableBillingFailure: true }` so the caller transparently
 * retries once with `skipUserToken: true` (Tier 3+ fallback).
 */
async function pipeWithPreStreamRetryCheck(
  source: ReadableStream<UIMessageChunk>,
  writeChunk: (chunk: UIMessageChunk) => void,
  canRetryTier2: boolean,
): Promise<{ retryableBillingFailure: boolean }> {
  const reader = source.getReader();
  const buffered: UIMessageChunk[] = [];
  let emitted = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (!emitted) {
          for (const item of buffered) {
            writeChunk(item);
          }
        }
        return { retryableBillingFailure: false };
      }

      if (!emitted && canRetryTier2) {
        if (isErrorChunkWithUserBillingFailure(value)) {
          await reader.cancel().catch(() => undefined);
          return { retryableBillingFailure: true };
        }

        // Hold initial start/start-step framing until real content or finish arrives.
        if (value.type === 'start' || value.type === 'start-step') {
          buffered.push(value);
          continue;
        }

        emitted = true;
        for (const item of buffered) {
          writeChunk(item);
        }
        buffered.length = 0;
      }

      writeChunk(value);
    }
  } catch (error) {
    if (!emitted && canRetryTier2 && isUserTokenBillingError(error)) {
      return { retryableBillingFailure: true };
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = performance.now();

  try {
    const body = (await request.json().catch(() => null)) as ExtendedChatRequestBody | null;
    if (!body || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: 'Invalid request body: expected "messages" array.' },
        { status: 400 },
      );
    }

    const session = await getServerSession(request.headers);
    const chatId = body.id?.trim() || generateId('chat');

    if (body.id?.trim()) {
      const existing = await getChatById(chatId);
      if (existing && existing.userId !== session.userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const override = mergeProviderOverride(body);
    const githubToken =
      body.enableGithubTools === false
        ? undefined
        : body.githubToken?.trim() || override?.githubToken?.trim() || undefined;

    const userVercelAuth: UserVercelAuth | undefined = session.vercelAuth
      ? {
          accessToken: session.vercelAuth.accessToken,
          refreshToken: session.vercelAuth.refreshToken,
          expiresAt: session.vercelAuth.expiresAt,
          providerId: session.vercelAuth.providerId,
          onRefreshed: async (tokens) => {
            await updateVercelTokens(session.userId, {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              providerId: session.vercelAuth?.providerId,
            });
          },
        }
      : undefined;

    let resolved = await resolveLanguageModel({
      modelId: body.modelId,
      override,
      userVercelAuth,
    });

    // Ensure chat exists before tools run so artifacts & workspace files satisfy Postgres FKs.
    const chatRecord = await ensureChat({
      id: chatId,
      userId: session.userId,
      modelId: resolved.modelId,
      harnessMode: 'ai-sdk',
    });

    if (chatRecord.userId !== session.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const effectiveSandboxTier = body.sandboxTier ?? getActiveTier(chatId);
    const tools = await createAdeTools({
      chatId,
      userId: session.userId,
      sandboxTier: effectiveSandboxTier,
      enableUiBridge: body.enableUiBridge ?? true,
      uiActRequireApproval: body.uiActRequireApproval ?? true,
      providerOverride: override,
      userVercelAuth,
      githubToken,
    });

    let validatedMessages: UIMessage<MessageMetadata>[];
    try {
      validatedMessages = await validateUIMessages<UIMessage<MessageMetadata>>({
        messages: body.messages,
        tools,
      });
    } catch {
      // Fallback when prior turns reference optional tools (e.g. GitHub) toggled off on this turn.
      validatedMessages = await validateUIMessages<UIMessage<MessageMetadata>>({
        messages: body.messages,
      });
    }

    const modelMessages = await convertToModelMessages(validatedMessages, {
      tools,
      ignoreIncompleteToolCalls: true,
    });

    const workspaceEntries = await listFiles(chatId, effectiveSandboxTier).catch(() => []);
    const instructions = buildAdeSystemPrompt({
      harnessMode: 'ai-sdk',
      sandboxTier: effectiveSandboxTier,
      enableGenUi: body.enableGenUi ?? true,
      enableUiBridge: body.enableUiBridge ?? true,
      enableGithubTools: Boolean(githubToken),
      uiSnapshot: body.uiSnapshot,
      workspaceFiles: workspaceEntries.map((entry) => entry.path),
    });

    const latestUserMessage = [...validatedMessages].reverse().find((msg) => msg.role === 'user');

    let activeResolved = resolved;
    let finalOutcome: 'ok' | 'error' = 'ok';
    let finalAssistantMessage: UIMessage<MessageMetadata> | null = null;

    const buildStreamForResolved = (currentResolved: typeof resolved) => {
      let reasoningStartedAt: number | null = null;
      let reasoningDurationMs = 0;

      const result = streamText({
        model: currentResolved.model,
        instructions,
        messages: modelMessages,
        tools,
        stopWhen: isStepCount(12),
        onEnd: () => {
          const durationMs = Math.round(performance.now() - startedAt);
          try {
            metric('ade.chat.duration_ms', durationMs, { harness: 'ai-sdk' });
            metric('ade.chat.requests', 1, {
              harness: 'ai-sdk',
              billing_source: currentResolved.billingSource,
              outcome: finalOutcome,
            });
          } catch {
            // Metrics are best-effort.
          }
        },
      });

      const uiStream = result.toUIMessageStream<UIMessage<MessageMetadata>>({
        originalMessages: validatedMessages,
        sendReasoning: true,
        sendSources: true,
        messageMetadata: ({ part }): MessageMetadata | undefined => {
          if (part.type === 'reasoning-start') {
            reasoningStartedAt = performance.now();
            return undefined;
          }
          if (part.type === 'reasoning-end' && reasoningStartedAt !== null) {
            reasoningDurationMs += Math.round(performance.now() - reasoningStartedAt);
            reasoningStartedAt = null;
            return undefined;
          }
          if (part.type === 'start') {
            return {
              createdAt: new Date().toISOString(),
              modelId: currentResolved.modelId,
              harnessMode: 'ai-sdk',
              billingSource: currentResolved.billingSource,
              billingLabel: currentResolved.billingInfo.label,
            };
          }
          if (part.type === 'finish') {
            return {
              createdAt: new Date().toISOString(),
              modelId: currentResolved.modelId,
              harnessMode: 'ai-sdk',
              billingSource: currentResolved.billingSource,
              billingLabel: currentResolved.billingInfo.label,
              latencyMs: Math.round(performance.now() - startedAt),
              ...(reasoningDurationMs > 0 ? { reasoningDurationMs } : {}),
              usage: buildUsageSummary(currentResolved.modelId, part.totalUsage),
            };
          }
          return undefined;
        },
      });

      return pipeJsonRender(uiStream as unknown as ReadableStream<UIMessageChunk>);
    };

    const uiMessageStream = createUIMessageStream<UIMessage<MessageMetadata>>({
      originalMessages: validatedMessages,
      execute: async ({ writer }) => {
        const canRetryTier2 =
          activeResolved.billingSource === 'user-vercel-oauth' &&
          Boolean(userVercelAuth?.accessToken);

        const firstStream = buildStreamForResolved(activeResolved);
        const { retryableBillingFailure } = await pipeWithPreStreamRetryCheck(
          firstStream,
          (chunk) => writer.write(chunk as Parameters<typeof writer.write>[0]),
          canRetryTier2,
        );

        if (retryableBillingFailure && userVercelAuth?.accessToken) {
          invalidateVercelGatewayCreditsCache(userVercelAuth.accessToken);
          resolved = await resolveLanguageModel({
            modelId: body.modelId,
            override,
            userVercelAuth,
            skipUserToken: true,
          });
          activeResolved = resolved;
          const retryStream = buildStreamForResolved(activeResolved);
          writer.merge(retryStream as unknown as Parameters<typeof writer.merge>[0]);
        }
      },
      onError: (error) => {
        finalOutcome = 'error';
        return error instanceof Error ? error.message : 'An unexpected streaming error occurred.';
      },
      onEnd: ({ responseMessage }) => {
        finalAssistantMessage = responseMessage;
      },
    });

    after(async () => {
      try {
        const toSave: Parameters<typeof saveMessages>[1] = [];
        if (latestUserMessage) {
          toSave.push({
            id: latestUserMessage.id || generateId('msg'),
            chatId,
            role: 'user',
            parts: latestUserMessage.parts,
            metadata: latestUserMessage.metadata ?? null,
          });
        }
        if (finalAssistantMessage && finalAssistantMessage.parts.length > 0) {
          toSave.push({
            id: finalAssistantMessage.id || generateId('msg'),
            chatId,
            role: 'assistant',
            parts: finalAssistantMessage.parts,
            metadata: {
              ...(finalAssistantMessage.metadata ?? {}),
              modelId: activeResolved.modelId,
              harnessMode: 'ai-sdk',
              billingSource: activeResolved.billingSource,
              billingLabel: activeResolved.billingInfo.label,
              latencyMs: Math.round(performance.now() - startedAt),
            },
          });
        }

        if (toSave.length > 0) {
          await saveMessages(chatId, toSave);
        }

        const existingChat = await getChatById(chatId);
        if (existingChat && existingChat.title === 'New chat') {
          const firstPrompt = extractFirstUserText(validatedMessages);
          if (firstPrompt) {
            let generatedTitle = truncateText(firstPrompt.replace(/\s+/g, ' '), 56);
            try {
              const fastModel = await resolveFastLanguageModel({
                override,
                userVercelAuth,
                skipUserToken: activeResolved.billingSource !== 'user-vercel-oauth',
              });
              const titleRes = await generateText({
                model: fastModel.model,
                instructions:
                  'Generate a crisp, 3 to 6 word title for this conversation. Return only the plain title without quotes, markdown, or trailing punctuation.',
                prompt: truncateText(firstPrompt, 400),
                maxOutputTokens: 24,
              });
              const cleaned = titleRes.text
                .replace(/^["'\s#*]+|["'\s.?!]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              if (cleaned.length >= 2 && cleaned.length <= 80) {
                generatedTitle = cleaned;
              }
            } catch {
              // Deterministic truncated fallback title is already set.
            }

            await updateChat(chatId, {
              title: generatedTitle,
              modelId: activeResolved.modelId,
              harnessMode: 'ai-sdk',
            });
          }
        } else if (existingChat) {
          await updateChat(chatId, {
            modelId: activeResolved.modelId,
            harnessMode: 'ai-sdk',
          });
        }

        if (finalOutcome === 'error') {
          metric('ade.chat.requests', 1, {
            harness: 'ai-sdk',
            billing_source: activeResolved.billingSource,
            outcome: 'error',
          });
        }
      } catch {
        // Persistence in after() must never throw unhandled rejections.
      }
    });

    const resumableContext = getOptionalResumableContext();
    return createUIMessageStreamResponse({
      stream: uiMessageStream,
      headers: {
        'X-Ade-Chat-Id': chatId,
        'X-Ade-Harness': 'ai-sdk',
        'X-Ade-Model-Id': activeResolved.modelId,
        'X-Ade-Billing-Source': activeResolved.billingSource,
      },
      ...(resumableContext
        ? {
            consumeSseStream: async ({ stream }) => {
              try {
                await resumableContext.createNewResumableStream(chatId, () => stream);
              } catch {
                // Resumable stream persistence is strictly optional.
              }
            },
          }
        : {}),
    });
  } catch (error) {
    try {
      metric('ade.chat.requests', 1, {
        harness: 'ai-sdk',
        billing_source: 'unconfigured',
        outcome: 'error',
      });
    } catch {
      // Best-effort telemetry.
    }

    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          billingSource: error.billingSource,
        },
        { status: 503 },
      );
    }

    const message = error instanceof Error ? error.message : 'Chat execution failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
