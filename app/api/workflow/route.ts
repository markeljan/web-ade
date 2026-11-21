import { createHmac } from 'node:crypto';
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { pipeJsonRender } from '@json-render/core';
import { metric } from '@vercel/functions';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  type UIMessage,
  type UIMessageChunk,
  validateUIMessages,
} from 'ai';
import { after, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import {
  ProviderNotConfiguredError,
  type ProviderOverrideInput,
  resolveLanguageModel,
  type UserVercelAuth,
} from '@/lib/ai/provider';
import { buildAdeSystemPrompt } from '@/lib/ai/system-prompt';
import { createAdeTools } from '@/lib/ai/tools/index';
import { getServerSession, updateVercelTokens } from '@/lib/auth/session';
import { ensureChat, getChatById, saveMessages, updateChat } from '@/lib/db/queries';
import { getActiveTier, listFiles } from '@/lib/sandbox/manager';
import type { ChatRequestBody, MessageMetadata, SandboxTier } from '@/lib/types';
import { generateId, truncateText } from '@/lib/utils';
import { adeAgentWorkflow } from '@/lib/workflows/agent-workflow';

export const maxDuration = 300;

const WORKFLOW_RUN_COOKIE = 'ade_wf_runs';
const RUN_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHED_RUNS = 2_000;

interface WorkflowRunOwnership {
  userId: string;
  chatId: string;
  createdAt: number;
}

const globalWorkflowState = globalThis as typeof globalThis & {
  __webAdeWorkflowRuns?: Map<string, WorkflowRunOwnership>;
};

function recordWorkflowRunOwner(runId: string, userId: string, chatId: string): void {
  if (!globalWorkflowState.__webAdeWorkflowRuns) {
    globalWorkflowState.__webAdeWorkflowRuns = new Map();
  }
  const map = globalWorkflowState.__webAdeWorkflowRuns;
  const now = Date.now();
  if (map.size >= MAX_CACHED_RUNS) {
    for (const [key, entry] of map) {
      if (now - entry.createdAt > RUN_TTL_MS) {
        map.delete(key);
      }
    }
    if (map.size >= MAX_CACHED_RUNS) {
      const oldest = map.keys().next().value;
      if (oldest) {
        map.delete(oldest);
      }
    }
  }
  map.set(runId, { userId, chatId, createdAt: now });
}

function buildWorkflowRunOwnerSetCookie(
  existingCookieHeader: string | null,
  runId: string,
  userId: string,
  chatId: string,
): string | null {
  const secret = process.env.BETTER_AUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret) {
    return null;
  }

  let existingEntries: string[] = [];
  if (existingCookieHeader) {
    for (const part of existingCookieHeader.split(';')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;
      if (part.slice(0, eqIdx).trim() === WORKFLOW_RUN_COOKIE) {
        const raw = decodeURIComponent(part.slice(eqIdx + 1).trim());
        existingEntries = raw.split(',').filter(Boolean);
        break;
      }
    }
  }

  const payload = `${runId}|${userId}|${chatId}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  const encoded = Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
  const nextEntries = [...existingEntries.slice(-9), encoded].join(',');

  const attributes = [
    `${WORKFLOW_RUN_COOKIE}=${encodeURIComponent(nextEntries)}`,
    'Path=/api/workflow',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=86400',
  ];
  if (process.env.NODE_ENV === 'production') {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

interface ExtendedWorkflowRequestBody extends ChatRequestBody {
  sandboxTier?: SandboxTier;
  customBaseUrl?: string;
  customApiKey?: string;
  customModel?: string;
  byokApiKey?: string;
  githubToken?: string;
  uiActRequireApproval?: boolean;
}

function mergeProviderOverride(
  body: ExtendedWorkflowRequestBody,
): ProviderOverrideInput | undefined {
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

function extractLastUserText(messages: UIMessage<MessageMetadata>[]): string {
  const lastUser = [...messages].reverse().find((msg) => msg.role === 'user');
  if (!lastUser) {
    return '';
  }
  return lastUser.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = performance.now();

  try {
    const body = (await request.json().catch(() => null)) as ExtendedWorkflowRequestBody | null;
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

    const resolved = await resolveLanguageModel({
      modelId: body.modelId,
      override,
      userVercelAuth,
    });

    const chatRecord = await ensureChat({
      id: chatId,
      userId: session.userId,
      modelId: resolved.modelId,
      harnessMode: 'workflow',
    });

    if (chatRecord.userId !== session.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const validatedMessages = await validateUIMessages<UIMessage<MessageMetadata>>({
      messages: body.messages,
    });

    const latestUserMessage = [...validatedMessages].reverse().find((msg) => msg.role === 'user');
    const promptText = extractLastUserText(validatedMessages);
    const effectiveSandboxTier = body.sandboxTier ?? getActiveTier(chatId);

    // Durable Workflow 5 runs natively on host-authenticated tiers (OIDC, AI_GATEWAY_API_KEY,
    // or OPENAI_API_KEY) without ever serializing ephemeral user BYOK/OAuth secrets into run logs.
    const canRunDurableWorkflow =
      resolved.billingSource === 'vercel-oidc' ||
      resolved.billingSource === 'sponsor-gateway' ||
      resolved.billingSource === 'sponsor-openai';

    if (canRunDurableWorkflow) {
      try {
        const run = await start(adeAgentWorkflow, [
          {
            chatId,
            userId: session.userId,
            messages: validatedMessages,
            modelId: resolved.modelId,
            providerKind: resolved.billingSource === 'sponsor-openai' ? 'openai' : 'gateway',
            billingSource: resolved.billingSource,
            billingLabel: resolved.billingInfo.label,
            sandboxTier: effectiveSandboxTier,
            enableGenUi: body.enableGenUi ?? true,
            uiSnapshot: body.uiSnapshot,
          },
        ]);

        recordWorkflowRunOwner(run.runId, session.userId, chatId);
        const ownerSetCookie = buildWorkflowRunOwnerSetCookie(
          request.headers.get('cookie'),
          run.runId,
          session.userId,
          chatId,
        );

        after(async () => {
          try {
            metric('ade.chat.requests', 1, {
              harness: 'workflow',
              billing_source: resolved.billingSource,
              outcome: 'ok',
            });
            metric('ade.chat.duration_ms', Math.round(performance.now() - startedAt), {
              harness: 'workflow',
            });

            if (latestUserMessage) {
              await saveMessages(chatId, [
                {
                  id: latestUserMessage.id || generateId('msg'),
                  chatId,
                  role: 'user',
                  parts: latestUserMessage.parts,
                  metadata: latestUserMessage.metadata ?? null,
                },
              ]);
            }

            const existingChat = await getChatById(chatId);
            if (existingChat && existingChat.title === 'New chat' && promptText) {
              await updateChat(chatId, {
                title: truncateText(promptText.replace(/\s+/g, ' '), 56),
                modelId: resolved.modelId,
                harnessMode: 'workflow',
              });
            }
          } catch {
            // Persistence and telemetry are best-effort in after().
          }
        });

        const uiStream = pipeJsonRender(
          run.readable.pipeThrough(createModelCallToUIChunkTransform()),
        );

        const responseHeaders: Record<string, string> = {
          'x-workflow-run-id': run.runId,
          'X-Ade-Chat-Id': chatId,
          'X-Ade-Harness': 'workflow',
          'X-Ade-Workflow-Transport': 'workflow-5',
          'X-Ade-Model-Id': resolved.modelId,
          'X-Ade-Billing-Source': resolved.billingSource,
        };
        if (ownerSetCookie) {
          responseHeaders['Set-Cookie'] = ownerSetCookie;
        }

        return createUIMessageStreamResponse({
          stream: uiStream,
          headers: responseHeaders,
        });
      } catch {
        // Fall through cleanly to ephemeral AI SDK 7 execution if Workflow runtime is unavailable.
      }
    }

    // Security-preserving fallback for user BYOK / custom endpoint / OAuth tokens
    // (keeps ephemeral user secrets strictly in-memory instead of serializing them into workflow logs).
    const tools = await createAdeTools({
      chatId,
      userId: session.userId,
      sandboxTier: effectiveSandboxTier,
      enableUiBridge: body.enableUiBridge ?? true,
      uiActRequireApproval: body.uiActRequireApproval ?? true,
      providerOverride: override,
      userVercelAuth,
      githubToken: body.githubToken ?? override?.githubToken,
    });
    const workspaceEntries = await listFiles(chatId, effectiveSandboxTier).catch(() => []);
    const modelMessages = await convertToModelMessages(validatedMessages, {
      tools,
      ignoreIncompleteToolCalls: true,
    });

    let finalAssistantMessage: UIMessage<MessageMetadata> | null = null;

    const fallbackStream = createUIMessageStream<UIMessage<MessageMetadata>>({
      originalMessages: validatedMessages,
      execute: ({ writer }) => {
        const result = streamText({
          model: resolved.model,
          instructions: buildAdeSystemPrompt({
            harnessMode: 'workflow',
            sandboxTier: effectiveSandboxTier,
            enableGenUi: body.enableGenUi ?? true,
            enableUiBridge: body.enableUiBridge ?? true,
            uiSnapshot: body.uiSnapshot,
            workspaceFiles: workspaceEntries.map((entry) => entry.path),
          }),
          messages: modelMessages,
          tools,
          stopWhen: isStepCount(12),
        });

        const merged = pipeJsonRender(
          result.toUIMessageStream<UIMessage<MessageMetadata>>({
            originalMessages: validatedMessages,
            sendReasoning: true,
            sendSources: true,
            messageMetadata: ({ part }): MessageMetadata | undefined => {
              if (part.type === 'start' || part.type === 'finish') {
                return {
                  createdAt: new Date().toISOString(),
                  modelId: resolved.modelId,
                  harnessMode: 'workflow',
                  billingSource: resolved.billingSource,
                  billingLabel: resolved.billingInfo.label,
                  ...(part.type === 'finish'
                    ? { latencyMs: Math.round(performance.now() - startedAt) }
                    : {}),
                };
              }
              return undefined;
            },
          }) as unknown as ReadableStream<UIMessageChunk>,
        );

        writer.merge(merged as unknown as Parameters<typeof writer.merge>[0]);
      },
      onEnd: ({ responseMessage }) => {
        finalAssistantMessage = responseMessage;
      },
    });

    after(async () => {
      try {
        metric('ade.chat.requests', 1, {
          harness: 'workflow',
          billing_source: resolved.billingSource,
          outcome: 'ok',
        });
        metric('ade.chat.duration_ms', Math.round(performance.now() - startedAt), {
          harness: 'workflow',
        });

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
              modelId: resolved.modelId,
              harnessMode: 'workflow',
              billingSource: resolved.billingSource,
              billingLabel: resolved.billingInfo.label,
            },
          });
        }
        if (toSave.length > 0) {
          await saveMessages(chatId, toSave);
        }

        const existingChat = await getChatById(chatId);
        if (existingChat && existingChat.title === 'New chat' && promptText) {
          await updateChat(chatId, {
            title: truncateText(promptText.replace(/\s+/g, ' '), 56),
            modelId: resolved.modelId,
            harnessMode: 'workflow',
          });
        } else if (existingChat) {
          await updateChat(chatId, {
            modelId: resolved.modelId,
            harnessMode: 'workflow',
          });
        }
      } catch {
        // Best-effort persistence.
      }
    });

    return createUIMessageStreamResponse({
      stream: fallbackStream,
      headers: {
        'X-Ade-Chat-Id': chatId,
        'X-Ade-Harness': 'workflow',
        'X-Ade-Workflow-Transport': 'ephemeral-fallback',
        'X-Ade-Model-Id': resolved.modelId,
        'X-Ade-Billing-Source': resolved.billingSource,
      },
    });
  } catch (error) {
    try {
      metric('ade.chat.requests', 1, {
        harness: 'workflow',
        billing_source: 'unconfigured',
        outcome: 'error',
      });
    } catch {
      // Best-effort telemetry.
    }

    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, billingSource: error.billingSource },
        { status: 503 },
      );
    }

    const message = error instanceof Error ? error.message : 'Workflow execution failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
