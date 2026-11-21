import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import { getVercelOidcToken } from '@vercel/functions/oidc';
import { type ToolSet, tool } from 'ai';
import { local as durableLocal } from 'libfx/durable-local';
import { vercel as durableVercel } from 'libfx/durable-vercel';
import {
  createFxAgent,
  type Durability,
  type FxAgent,
  type FxAgentHostTool,
  type FxCustomProviderDefinition,
  type FxFetch,
  type FxSessionPromptInput,
  type FxSessionTurnEvent,
  type FxToolContext,
  type FxTurnResult,
  getBackendInfo,
  memory,
} from 'libfx/node';
import { z } from 'zod';
import type { ResolvedFxCredentials } from '@/lib/ai/provider';
import { buildFxSystemPrompt } from '@/lib/ai/system-prompt';
import { isDestructiveCommand } from '@/lib/ai/tools/index';
import { saveArtifact, syncWorkspaceFiles } from '@/lib/db/queries';
import {
  execCommand,
  getAllFilesRecord,
  listFiles,
  readFile,
  writeFile,
} from '@/lib/sandbox/manager';
import type { SandboxTier } from '@/lib/types';

export const MAX_TURN_MODEL_STEPS = 64;

interface TurnCredentialLease {
  apiKey?: string;
  headers: Record<string, string>;
  steps: number;
}

interface FxToolSessionContext {
  chatId: string;
  userId: string;
  sandboxTier?: SandboxTier;
}

const globalFxState = globalThis as typeof globalThis & {
  __webAdeFxAgent?: FxAgent;
  __webAdeFxLeaseStorage?: AsyncLocalStorage<TurnCredentialLease>;
};

function getLeaseStorage(): AsyncLocalStorage<TurnCredentialLease> {
  if (!globalFxState.__webAdeFxLeaseStorage) {
    globalFxState.__webAdeFxLeaseStorage = new AsyncLocalStorage<TurnCredentialLease>();
  }
  return globalFxState.__webAdeFxLeaseStorage;
}

/**
 * Custom `fx0`-style fetch wrapper injecting per-turn resolved 5-tier credentials
 * via `AsyncLocalStorage` (zero cross-tenant races, zero secrets persisted in libfx journals)
 * and enforcing the `MAX_TURN_MODEL_STEPS` per-turn / per-wake-request model step budget.
 */
function createCredentialAndBudgetFetch(fallbackCreds?: ResolvedFxCredentials): FxFetch {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const isModelPost =
      (init.method ?? 'GET').toUpperCase() === 'POST' &&
      (input.includes('/language-model') ||
        input.includes('/chat/completions') ||
        input.includes('/responses'));

    const activeLease = getLeaseStorage().getStore();

    if (isModelPost && activeLease) {
      activeLease.steps += 1;
      if (activeLease.steps > MAX_TURN_MODEL_STEPS) {
        throw new Error(`fx turn exceeded model step budget (${MAX_TURN_MODEL_STEPS} steps).`);
      }
    }

    const headers = new Headers(init.headers);
    const apiKey = activeLease?.apiKey ?? fallbackCreds?.apiKey;
    const extraHeaders = activeLease?.headers ?? fallbackCreds?.headers;

    if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        headers.set(key, value);
      }
    }

    return fetch(input, { ...init, headers });
  };
}

function extractSessionContext(ctx: FxToolContext): FxToolSessionContext {
  const raw =
    ctx.context && typeof ctx.context === 'object' && !Array.isArray(ctx.context)
      ? (ctx.context as Record<string, unknown>)
      : {};

  return {
    chatId: typeof raw.chatId === 'string' && raw.chatId.trim() ? raw.chatId : ctx.sessionId,
    userId: typeof raw.userId === 'string' && raw.userId.trim() ? raw.userId : 'guest',
    sandboxTier:
      raw.sandboxTier === 'just-bash' ||
      raw.sandboxTier === 'vercel-sandbox' ||
      raw.sandboxTier === 'remote-agent-browser'
        ? raw.sandboxTier
        : undefined,
  };
}

async function persistWorkspaceSnapshot(chatId: string, sandboxTier?: SandboxTier): Promise<void> {
  try {
    const allFiles = await getAllFilesRecord(chatId, sandboxTier);
    await syncWorkspaceFiles(chatId, allFiles, { pruneMissing: true });
  } catch {
    // Best-effort sync; in-memory workspace state remains authoritative for active turn.
  }
}

/**
 * Idempotent host coding tools for `libfx` mapped directly onto `lib/sandbox/manager.ts`
 * and persistent Workbench HTML artifacts (`fx0` live preview pattern).
 */
export function createFxHostCodingTools(): readonly FxAgentHostTool[] {
  return [
    {
      name: 'list_files',
      description: 'List all files in the current ADE workspace.',
      idempotent: true,
      writes: false,
      inputSchema: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional relative directory prefix filter' },
        },
        additionalProperties: false,
      },
      execute: async (input: { prefix?: string }, context) => {
        const { chatId, sandboxTier } = extractSessionContext(context);
        const files = await listFiles(chatId, sandboxTier);
        const prefix = input?.prefix?.replace(/^\/+/, '');
        const filtered = prefix ? files.filter((f) => f.path.startsWith(prefix)) : files;
        return {
          count: filtered.length,
          files: filtered.map((f) => ({ path: f.path, size: f.size, language: f.language })),
        };
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 file from the current ADE workspace.',
      idempotent: true,
      writes: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace file path' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (input: { path: string }, context) => {
        const { chatId, sandboxTier } = extractSessionContext(context);
        const res = await readFile(chatId, input.path, sandboxTier);
        return {
          path: res.path,
          language: res.language,
          size: res.size,
          content: res.content.slice(0, 48_000),
        };
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file in the current ADE workspace.',
      idempotent: true,
      writes: true,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace file path' },
          content: { type: 'string', description: 'Complete UTF-8 file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async (input: { path: string; content: string }, context) => {
        const { chatId, sandboxTier } = extractSessionContext(context);
        const res = await writeFile(chatId, input.path, input.content, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        return {
          ok: true,
          path: res.path,
          size: res.size,
          language: res.language,
          tier: res.tier,
          workbenchTab: res.language === 'html' ? 'preview' : 'files',
        };
      },
    },
    {
      name: 'edit_file',
      description: 'Apply an exact string replacement inside an existing workspace file.',
      idempotent: false,
      writes: true,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace file path' },
          target: { type: 'string', description: 'Exact text snippet to replace' },
          replacement: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'target', 'replacement'],
        additionalProperties: false,
      },
      execute: async (input: { path: string; target: string; replacement: string }, context) => {
        const { chatId, sandboxTier } = extractSessionContext(context);
        const current = await readFile(chatId, input.path, sandboxTier);
        if (!current.content.includes(input.target)) {
          return {
            ok: false,
            error: `Target snippet not found in "${input.path}".`,
          };
        }
        const updated = current.content.replace(input.target, input.replacement);
        const res = await writeFile(chatId, input.path, updated, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        return {
          ok: true,
          path: res.path,
          size: res.size,
          tier: res.tier,
          workbenchTab: 'files',
        };
      },
    },
    {
      name: 'shell',
      description:
        'Execute a shell command in the session workspace (Tier 1 just-bash or Tier 2 Vercel Sandbox). Destructive commands are refused by Sentinel in unattended durable runs.',
      idempotent: false,
      writes: true,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Optional relative working directory' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      execute: async (input: { command: string; cwd?: string }, context) => {
        if (isDestructiveCommand(input.command)) {
          return {
            ok: false,
            blocked: true,
            error: `Sentinel blocked destructive command "${input.command}" inside autonomous fx run. Switch to AI SDK 7 mode for interactive Sentinel approval.`,
          };
        }
        const { chatId, sandboxTier } = extractSessionContext(context);
        const res = await execCommand(chatId, input.command, {
          cwd: input.cwd,
          tier: sandboxTier,
          signal: context.signal,
        });
        if (res.changedFiles.length > 0 || res.deletedFiles.length > 0) {
          await persistWorkspaceSnapshot(chatId, sandboxTier);
        }
        return {
          ok: res.exitCode === 0,
          exitCode: res.exitCode,
          tier: res.tier,
          durationMs: res.durationMs,
          stdout: res.stdout.slice(0, 24_000),
          stderr: res.stderr.slice(0, 12_000),
          changedFiles: res.changedFiles,
          deletedFiles: res.deletedFiles,
          workbenchTab: 'terminal',
        };
      },
    },
    {
      name: 'write_html_preview',
      description:
        'Publish a self-contained single-file HTML preview to both index.html and a persistent Workbench HTML artifact (fx0 instant preview).',
      idempotent: true,
      writes: true,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Preview title' },
          html: { type: 'string', description: 'Complete single-file HTML document' },
          path: { type: 'string', description: 'Workspace path (defaults to "index.html")' },
        },
        required: ['title', 'html'],
        additionalProperties: false,
      },
      execute: async (input: { title: string; html: string; path?: string }, context) => {
        const { chatId, userId, sandboxTier } = extractSessionContext(context);
        const targetPath = input.path?.trim() || 'index.html';
        await writeFile(chatId, targetPath, input.html, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        const artifact = await saveArtifact({
          chatId,
          userId,
          title: input.title,
          kind: 'html',
          language: 'html',
          content: input.html,
        });
        return {
          ok: true,
          path: targetPath,
          artifact,
          workbenchTab: 'preview',
        };
      },
    },
  ];
}

/**
 * AI SDK 7 equivalent of the exact same `fx` coding toolset, used cleanly when
 * falling back from libfx native transport (e.g., incompatible custom endpoint or missing WASM/N-API).
 */
export function createFxFallbackAiTools(context: FxToolSessionContext): ToolSet {
  const { chatId, userId, sandboxTier } = context;

  return {
    list_files: tool({
      description: 'List all files in the current ADE workspace.',
      inputSchema: z.object({ prefix: z.string().optional() }),
      execute: async ({ prefix }) => {
        const files = await listFiles(chatId, sandboxTier);
        const cleaned = prefix?.replace(/^\/+/, '');
        const filtered = cleaned ? files.filter((f) => f.path.startsWith(cleaned)) : files;
        return {
          count: filtered.length,
          files: filtered.map((f) => ({ path: f.path, size: f.size, language: f.language })),
        };
      },
    }),
    read_file: tool({
      description: 'Read a UTF-8 file from the current ADE workspace.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => {
        const res = await readFile(chatId, filePath, sandboxTier);
        return {
          path: res.path,
          language: res.language,
          size: res.size,
          content: res.content.slice(0, 48_000),
        };
      },
    }),
    write_file: tool({
      description: 'Create or overwrite a file in the current ADE workspace.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path: filePath, content }) => {
        const res = await writeFile(chatId, filePath, content, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        return {
          ok: true,
          path: res.path,
          size: res.size,
          language: res.language,
          tier: res.tier,
          workbenchTab: res.language === 'html' ? 'preview' : 'files',
        };
      },
    }),
    edit_file: tool({
      description: 'Apply an exact string replacement inside an existing workspace file.',
      inputSchema: z.object({
        path: z.string().min(1),
        target: z.string(),
        replacement: z.string(),
      }),
      execute: async ({ path: filePath, target, replacement }) => {
        const current = await readFile(chatId, filePath, sandboxTier);
        if (!current.content.includes(target)) {
          return { ok: false, error: `Target snippet not found in "${filePath}".` };
        }
        const updated = current.content.replace(target, replacement);
        const res = await writeFile(chatId, filePath, updated, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        return { ok: true, path: res.path, size: res.size, tier: res.tier, workbenchTab: 'files' };
      },
    }),
    shell: tool({
      description: 'Execute a shell command in the session workspace.',
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
      }),
      needsApproval: ({ command }) => isDestructiveCommand(command),
      execute: async ({ command, cwd }) => {
        const res = await execCommand(chatId, command, { cwd, tier: sandboxTier });
        if (res.changedFiles.length > 0 || res.deletedFiles.length > 0) {
          await persistWorkspaceSnapshot(chatId, sandboxTier);
        }
        return {
          ok: res.exitCode === 0,
          exitCode: res.exitCode,
          tier: res.tier,
          durationMs: res.durationMs,
          stdout: res.stdout.slice(0, 24_000),
          stderr: res.stderr.slice(0, 12_000),
          changedFiles: res.changedFiles,
          deletedFiles: res.deletedFiles,
          workbenchTab: 'terminal',
        };
      },
    }),
    write_html_preview: tool({
      description:
        'Publish a self-contained single-file HTML preview to index.html and a Workbench HTML artifact.',
      inputSchema: z.object({
        title: z.string().min(1),
        html: z.string().min(1),
        path: z.string().optional(),
      }),
      execute: async ({ title, html, path: filePath }) => {
        const targetPath = filePath?.trim() || 'index.html';
        await writeFile(chatId, targetPath, html, sandboxTier);
        await persistWorkspaceSnapshot(chatId, sandboxTier);
        const artifact = await saveArtifact({
          chatId,
          userId,
          title,
          kind: 'html',
          language: 'html',
          content: html,
        });
        return { ok: true, path: targetPath, artifact, workbenchTab: 'preview' };
      },
    }),
  };
}

function selectDurability(): Durability {
  if (process.env.VERCEL === '1') {
    return durableVercel({ reserveMs: 30_000 });
  }
  try {
    return durableLocal({
      dir: path.join(os.tmpdir(), 'web-ade-fx-sessions'),
      reserveMs: 30_000,
    });
  } catch {
    return memory({ reserveMs: 30_000 });
  }
}

/**
 * Returns the singleton durable `libfx` Gateway agent registered in this server process.
 * Passes a non-empty placeholder `apiKey` when host Gateway env vars are absent so `libfx`
 * never throws `TypeError` before our per-turn `AsyncLocalStorage` `fetch` injects Tier 2a/2b
 * user credentials.
 */
export function getFxAgent(): FxAgent {
  if (!globalFxState.__webAdeFxAgent) {
    const bootstrapApiKey =
      process.env.AI_GATEWAY_API_KEY?.trim() ||
      process.env.VERCEL_OIDC_TOKEN?.trim() ||
      'fx-per-turn-injected';

    globalFxState.__webAdeFxAgent = createFxAgent({
      name: 'web-ade-fx',
      apiKey: bootstrapApiKey,
      durability: selectDurability(),
      instructions: buildFxSystemPrompt(),
      tools: createFxHostCodingTools(),
      fetch: createCredentialAndBudgetFetch(),
    });
  }
  return globalFxState.__webAdeFxAgent;
}

/**
 * Returns the Vercel Fluid Compute / Queue wake handler for `app/api/libfx/route.ts`.
 * Wraps each queue delivery in an isolated `AsyncLocalStorage` step budget so cumulative
 * wake calls can never permanently exhaust the 64-step limit.
 */
export function getFxWakeHandler(): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const agent = getFxAgent();
    const oidcToken =
      process.env.VERCEL_OIDC_TOKEN?.trim() || (await getVercelOidcToken().catch(() => undefined));
    const wakeLease: TurnCredentialLease = {
      apiKey: process.env.AI_GATEWAY_API_KEY?.trim() || oidcToken || undefined,
      headers: {},
      steps: 0,
    };
    return getLeaseStorage().run(wakeLease, () => agent.wakeHandler()(request));
  };
}

export interface RunFxTurnOptions {
  chatId: string;
  userId: string;
  prompt: FxSessionPromptInput;
  credentials: ResolvedFxCredentials;
  sandboxTier?: SandboxTier;
  workspaceFiles?: string[];
  signal?: AbortSignal;
  onEvent: (event: FxSessionTurnEvent) => void;
}

export interface RunFxTurnOutcome {
  transport: 'libfx-durable' | 'libfx-custom';
  result: FxTurnResult;
}

/**
 * Executes a single `libfx` turn using either:
 * - The durable Vercel/local `FxAgent` (for Vercel AI Gateway credentials), or
 * - An ephemeral `FxCustomProvider` `FxAgent` (for direct OpenAI / custom OpenAI-compatible endpoints).
 *
 * Credentials & step budgets are bound strictly via `AsyncLocalStorage` per turn so concurrent
 * requests can never observe or overwrite another tenant's credentials.
 */
export async function runFxTurn(options: RunFxTurnOptions): Promise<RunFxTurnOutcome> {
  const { chatId, userId, prompt, credentials, sandboxTier, workspaceFiles, signal, onEvent } =
    options;

  const backendInfo = await getBackendInfo({ surface: 'agent' });
  if (backendInfo.backend === 'unavailable') {
    const reason = backendInfo.attempts
      .map((a) => (!a.available ? `${a.backend}:${a.reason.code}` : a.backend))
      .join(', ');
    throw new Error(`libfx runtime backend unavailable (${reason})`);
  }

  const instructions = buildFxSystemPrompt(workspaceFiles);
  const sanitizedSessionId = `fx_${chatId.replaceAll(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96)}`;
  const lease: TurnCredentialLease = {
    apiKey: credentials.apiKey,
    headers: { ...credentials.headers },
    steps: 0,
  };

  return getLeaseStorage().run(lease, async () => {
    try {
      if (credentials.mode === 'gateway') {
        const agent = getFxAgent();
        const session = agent.session(sanitizedSessionId, {
          model: credentials.modelId,
          instructions,
          context: {
            chatId,
            userId,
            ...(sandboxTier ? { sandboxTier } : {}),
          },
        });

        const turn = session.prompt(prompt, { signal });
        for await (const event of turn) {
          onEvent(event);
        }
        const result = await turn.result;
        return { transport: 'libfx-durable', result };
      }

      // OpenAI or Custom OpenAI-compatible provider via libfx FxCustomProvider.
      const customProviderDef: FxCustomProviderDefinition = {
        name: credentials.mode === 'openai' ? 'ade-openai' : 'ade-custom',
        baseUrl: credentials.baseUrl,
        modelDefaults: {
          supportsToolUse: true,
          supportsVision: true,
          outputLimitField: credentials.mode === 'openai' ? 'max_completion_tokens' : 'max_tokens',
        },
      };

      const ephemeralAgent = createFxAgent({
        name: 'web-ade-fx-custom',
        durability: memory({ reserveMs: 30_000 }),
        provider: customProviderDef,
        model: credentials.modelId,
        credentials: credentials.apiKey
          ? () => ({ apiKey: credentials.apiKey as string })
          : undefined,
        instructions,
        tools: createFxHostCodingTools(),
        fetch: createCredentialAndBudgetFetch(credentials),
      });

      try {
        const session = ephemeralAgent.session(sanitizedSessionId, {
          model: credentials.modelId,
          instructions,
          context: {
            chatId,
            userId,
            ...(sandboxTier ? { sandboxTier } : {}),
          },
        });
        const turn = session.prompt(prompt, { signal });
        for await (const event of turn) {
          onEvent(event);
        }
        const result = await turn.result;
        return { transport: 'libfx-custom', result };
      } finally {
        await ephemeralAgent.close().catch(() => undefined);
      }
    } finally {
      // Ensure any workspace file mutations made during the fx turn are persisted to storage.
      await persistWorkspaceSnapshot(chatId, sandboxTier);
    }
  });
}
