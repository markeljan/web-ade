import { openai } from '@ai-sdk/openai';
import { type ModelCallStreamPart, WorkflowAgent } from '@ai-sdk/workflow';
import { convertToModelMessages, isStepCount, type LanguageModel, type UIMessage } from 'ai';
import { getWritable } from 'workflow';
import { z } from 'zod';
import { toOpenAIDirectModelId } from '@/lib/ai/models';
import { buildAdeSystemPrompt } from '@/lib/ai/system-prompt';
import type {
  ArtifactKind,
  BillingSource,
  MessageMetadata,
  SandboxTier,
  UiAgentSnapshot,
} from '@/lib/types';

export interface AdeWorkflowInput {
  chatId: string;
  userId: string;
  messages: UIMessage<MessageMetadata>[];
  modelId: string;
  providerKind: 'gateway' | 'openai';
  billingSource: BillingSource;
  billingLabel: string;
  sandboxTier?: SandboxTier;
  enableGenUi?: boolean;
  uiSnapshot?: UiAgentSnapshot;
}

export interface AdeWorkflowResult {
  chatId: string;
  modelId: string;
  finishReason: string;
  stepCount: number;
  totalTokens: number;
}

/**
 * Pure deterministic Sentinel check safe to run inside the sandboxed `"use workflow"` VM
 * (zero Node.js module imports).
 */
const WORKFLOW_DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/,
  /\brm\s+--(?:recursive|force|no-preserve-root)\b/,
  /\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da|a)?sh\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bsudo\b/,
  /\bchmod\s+(?:-R\s+)?777\b/,
  /\b(?:mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/(?:sd|hd|nvme|disk)/,
  /\bkill\s+-9\b/,
  /\b(?:npm|bun|pnpm)\s+publish\b/,
  /\bvercel\s+(?:deploy\s+)?--prod\b/,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
];

function isDestructiveWorkflowCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return WORKFLOW_DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

/* -------------------------------------------------------------------------- */
/* Durable Workflow Steps ("use step") with Structured Observability Logging  */
/* All Node.js / DB / Sandbox modules are dynamically imported inside steps   */
/* so the sandboxed `"use workflow"` bundle remains 100% pure & deterministic */
/* -------------------------------------------------------------------------- */

async function stepListWorkspaceFiles(chatId: string, sandboxTier?: SandboxTier) {
  'use step';
  const startedAt = Date.now();
  const { listFiles } = await import('@/lib/sandbox/manager');
  const files = await listFiles(chatId, sandboxTier);
  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'list_files',
      chatId,
      fileCount: files.length,
      durationMs: Date.now() - startedAt,
    }),
  );
  return files.map((f) => ({ path: f.path, size: f.size, language: f.language }));
}

async function stepReadWorkspaceFile(chatId: string, filePath: string, sandboxTier?: SandboxTier) {
  'use step';
  const startedAt = Date.now();
  const { readFile } = await import('@/lib/sandbox/manager');
  try {
    const res = await readFile(chatId, filePath, sandboxTier);
    console.info(
      JSON.stringify({
        scope: 'ade.workflow.step',
        step: 'read_file',
        chatId,
        path: res.path,
        size: res.size,
        durationMs: Date.now() - startedAt,
      }),
    );
    return {
      ok: true,
      path: res.path,
      language: res.language,
      size: res.size,
      content: res.content.slice(0, 48_000),
    };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : 'Unable to read file.',
    };
  }
}

async function stepWriteWorkspaceFile(
  chatId: string,
  filePath: string,
  content: string,
  sandboxTier?: SandboxTier,
) {
  'use step';
  const startedAt = Date.now();
  const { writeFile } = await import('@/lib/sandbox/manager');
  const res = await writeFile(chatId, filePath, content, sandboxTier);
  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'write_file',
      chatId,
      path: res.path,
      size: res.size,
      tier: res.tier,
      durationMs: Date.now() - startedAt,
    }),
  );
  return {
    ok: true,
    path: res.path,
    size: res.size,
    language: res.language,
    tier: res.tier,
    workbenchTab: res.language === 'html' ? 'preview' : 'files',
  };
}

async function stepRunWorkspaceBash(
  chatId: string,
  command: string,
  cwd?: string,
  sandboxTier?: SandboxTier,
) {
  'use step';
  const startedAt = Date.now();
  const { execCommand } = await import('@/lib/sandbox/manager');
  const res = await execCommand(chatId, command, { cwd, tier: sandboxTier });
  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'bash',
      chatId,
      exitCode: res.exitCode,
      tier: res.tier,
      changedCount: res.changedFiles.length,
      durationMs: Date.now() - startedAt,
    }),
  );
  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    tier: res.tier,
    durationMs: res.durationMs,
    stdout: res.stdout.slice(0, 24_000),
    stderr: res.stderr.slice(0, 12_000),
    changedFiles: res.changedFiles,
    workbenchTab: 'terminal',
  };
}

async function stepSaveArtifact(params: {
  chatId: string;
  userId: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  language?: string;
  sandboxTier?: SandboxTier;
}) {
  'use step';
  const startedAt = Date.now();
  const [{ saveArtifact }, { writeFile }] = await Promise.all([
    import('@/lib/db/queries'),
    import('@/lib/sandbox/manager'),
  ]);

  const saved = await saveArtifact({
    chatId: params.chatId,
    userId: params.userId,
    title: params.title,
    kind: params.kind,
    language: params.language ?? (params.kind === 'html' ? 'html' : undefined),
    content: params.content,
  });

  if (params.kind === 'html') {
    await writeFile(params.chatId, 'index.html', params.content, params.sandboxTier).catch(
      () => undefined,
    );
  }

  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'create_artifact',
      chatId: params.chatId,
      artifactId: saved.id,
      kind: saved.kind,
      durationMs: Date.now() - startedAt,
    }),
  );

  return {
    ok: true,
    artifact: saved,
    workbenchTab: params.kind === 'html' ? 'preview' : params.kind === 'genui' ? 'genui' : 'files',
  };
}

async function stepBrowserOpen(chatId: string, url: string) {
  'use step';
  const startedAt = Date.now();
  const { browserOpen } = await import('@/lib/sandbox/browser-service');
  const res = await browserOpen(chatId, url);
  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'browser_open',
      chatId,
      ok: res.ok,
      backend: res.backend,
      durationMs: Date.now() - startedAt,
    }),
  );
  return {
    ok: res.ok,
    url: res.url,
    title: res.title,
    mode: res.mode,
    backend: res.backend,
    snapshotTree: res.snapshotTree?.slice(0, 8_000),
    textSummary: res.textSummary?.slice(0, 4_000),
    error: res.error,
    workbenchTab: 'browser',
  };
}

async function stepBrowserSnapshot(chatId: string) {
  'use step';
  const startedAt = Date.now();
  const { browserSnapshot } = await import('@/lib/sandbox/browser-service');
  const res = await browserSnapshot(chatId);
  console.info(
    JSON.stringify({
      scope: 'ade.workflow.step',
      step: 'browser_snapshot',
      chatId,
      ok: res.ok,
      durationMs: Date.now() - startedAt,
    }),
  );
  return {
    ok: res.ok,
    url: res.url,
    title: res.title,
    snapshotTree: res.snapshotTree?.slice(0, 8_000),
    error: res.error,
    workbenchTab: 'browser',
  };
}

async function stepWebFetch(url: string, maxChars: number) {
  'use step';
  const startedAt = Date.now();
  const { readResponseTextBounded, safeExternalFetch } = await import(
    '@/lib/sandbox/browser-service'
  );

  try {
    const { response, finalUrl } = await safeExternalFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'WebADE-Workflow/1.0' },
      maxRedirects: 5,
      timeoutMs: 10_000,
    });

    const rawText = await readResponseTextBounded(response, 512 * 1024);
    const text = rawText
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.info(
      JSON.stringify({
        scope: 'ade.workflow.step',
        step: 'web_fetch',
        status: response.status,
        bytes: text.length,
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      ok: response.ok,
      status: response.status,
      url: finalUrl,
      content: text.slice(0, maxChars),
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : 'Web fetch failed.',
    };
  }
}

async function stepPersistAssistantReply(params: {
  chatId: string;
  text: string;
  modelId: string;
  billingSource: BillingSource;
  billingLabel: string;
  totalTokens: number;
}) {
  'use step';
  if (!params.text.trim()) {
    return;
  }
  const { saveMessages } = await import('@/lib/db/queries');
  await saveMessages(params.chatId, [
    {
      chatId: params.chatId,
      role: 'assistant',
      parts: [{ type: 'text', text: params.text }],
      metadata: {
        createdAt: new Date().toISOString(),
        modelId: params.modelId,
        harnessMode: 'workflow',
        billingSource: params.billingSource,
        billingLabel: params.billingLabel,
        ...(params.totalTokens > 0
          ? {
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: params.totalTokens,
              },
            }
          : {}),
      },
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Durable Workflow 5 Agent Entrypoint ("use workflow")                       */
/* -------------------------------------------------------------------------- */

export async function adeAgentWorkflow(input: AdeWorkflowInput): Promise<AdeWorkflowResult> {
  'use workflow';

  console.info(
    JSON.stringify({
      scope: 'ade.workflow',
      event: 'start',
      chatId: input.chatId,
      modelId: input.modelId,
      providerKind: input.providerKind,
      messageCount: input.messages.length,
    }),
  );

  const writable = getWritable<ModelCallStreamPart>();
  const workspaceFiles = await stepListWorkspaceFiles(input.chatId, input.sandboxTier);

  const instructions = buildAdeSystemPrompt({
    harnessMode: 'workflow',
    sandboxTier: input.sandboxTier ?? 'just-bash',
    enableGenUi: input.enableGenUi ?? true,
    enableUiBridge: false,
    uiSnapshot: input.uiSnapshot,
    workspaceFiles: workspaceFiles.map((f) => f.path),
  });

  const model: LanguageModel =
    input.providerKind === 'openai' ? openai(toOpenAIDirectModelId(input.modelId)) : input.modelId;

  const agent = new WorkflowAgent({
    id: 'web-ade-workflow-agent',
    model,
    instructions,
    stopWhen: isStepCount(12),
    tools: {
      list_files: {
        description: 'List all files in the current session workspace.',
        inputSchema: z.object({}),
        execute: async () => stepListWorkspaceFiles(input.chatId, input.sandboxTier),
      },
      read_file: {
        description: 'Read a file from the current session workspace.',
        inputSchema: z.object({ path: z.string().min(1) }),
        execute: async ({ path }) => stepReadWorkspaceFile(input.chatId, path, input.sandboxTier),
      },
      write_file: {
        description: 'Create or update a file in the current session workspace.',
        inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
        execute: async ({ path, content }) =>
          stepWriteWorkspaceFile(input.chatId, path, content, input.sandboxTier),
      },
      bash: {
        description:
          'Execute a bash command inside the session workspace (durable retryable step).',
        inputSchema: z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
        }),
        needsApproval: ({ command }: { command: string }) => isDestructiveWorkflowCommand(command),
        execute: async ({ command, cwd }) =>
          stepRunWorkspaceBash(input.chatId, command, cwd, input.sandboxTier),
      },
      create_artifact: {
        description:
          'Create a persistent Workbench artifact (HTML preview, code, doc, genui, diff).',
        inputSchema: z.object({
          title: z.string().min(1).max(160),
          kind: z.enum(['code', 'document', 'html', 'genui', 'diff']),
          content: z.string(),
          language: z.string().optional(),
        }),
        execute: async ({ title, kind, content, language }) =>
          stepSaveArtifact({
            chatId: input.chatId,
            userId: input.userId,
            title,
            kind,
            content,
            language,
            sandboxTier: input.sandboxTier,
          }),
      },
      browser_open: {
        description:
          'Open a URL in the embedded ADE browser and capture its accessibility snapshot.',
        inputSchema: z.object({ url: z.string().min(1) }),
        execute: async ({ url }) => stepBrowserOpen(input.chatId, url),
      },
      browser_snapshot: {
        description: 'Capture an updated snapshot of the current browser page.',
        inputSchema: z.object({}),
        execute: async () => stepBrowserSnapshot(input.chatId),
      },
      web_fetch: {
        description: 'Fetch a public URL and extract clean readable text.',
        inputSchema: z.object({
          url: z.string().min(1),
          maxChars: z.number().int().min(500).max(24_000).default(12_000),
        }),
        execute: async ({ url, maxChars }) => stepWebFetch(url, maxChars),
      },
    },
  });

  const modelMessages = await convertToModelMessages(input.messages, {
    ignoreIncompleteToolCalls: true,
  });

  const result = await agent.stream({
    messages: modelMessages,
    writable,
  });

  const assistantText = result.steps
    .map((step) => step.text)
    .filter(Boolean)
    .join('\n')
    .trim();

  const totalTokens =
    result.totalUsage.totalTokens ??
    (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0);

  await stepPersistAssistantReply({
    chatId: input.chatId,
    text: assistantText,
    modelId: input.modelId,
    billingSource: input.billingSource,
    billingLabel: input.billingLabel,
    totalTokens,
  });

  console.info(
    JSON.stringify({
      scope: 'ade.workflow',
      event: 'complete',
      chatId: input.chatId,
      stepCount: result.steps.length,
      finishReason: result.finishReason,
      totalTokens,
    }),
  );

  return {
    chatId: input.chatId,
    modelId: input.modelId,
    finishReason: result.finishReason,
    stepCount: result.steps.length,
    totalTokens,
  };
}
