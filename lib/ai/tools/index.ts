import { createGithubTools } from '@github-tools/sdk';
import { put } from '@vercel/blob';
import { generateImage, generateText, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { invalidateVercelGatewayCreditsCache, isUserTokenBillingError } from '@/lib/ai/credits';
import {
  type ProviderOverrideInput,
  resolveImageGenerator,
  type UserVercelAuth,
} from '@/lib/ai/provider';
import { getLatestArtifact, saveArtifact } from '@/lib/db/queries';
import {
  browserClick,
  browserFill,
  browserOpen,
  browserPress,
  browserRead,
  browserScreenshot,
  browserScroll,
  browserSnapshot,
  readResponseTextBounded,
  safeExternalFetch,
} from '@/lib/sandbox/browser-service';
import { createWorkspaceBashTool, listFiles, readFile, writeFile } from '@/lib/sandbox/manager';
import type { ArtifactKind, SandboxTier } from '@/lib/types';
import { generateId, sanitizeFilename } from '@/lib/utils';

const MAX_WEB_FETCH_BYTES = 512 * 1024; // 512 KB strict streaming cap

const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
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

/**
 * Sentinel safety check determining whether a shell command requires explicit
 * human-in-the-loop approval before execution.
 */
export function isDestructiveCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'");
}

function htmlToReadableText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
    : undefined;

  const text = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(h[1-6])[^>]*>/gi, '\n\n## ')
      .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|article|header|footer|br)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );

  return { title, text };
}

function artifactTabForKind(kind: ArtifactKind): 'preview' | 'genui' | 'files' {
  if (kind === 'html') return 'preview';
  if (kind === 'genui') return 'genui';
  return 'files';
}

export interface CreateAdeToolsOptions {
  chatId: string;
  userId: string;
  sandboxTier?: SandboxTier;
  enableUiBridge?: boolean;
  /** Whether `ui_act` requires explicit Sentinel human approval before executing (default true). */
  uiActRequireApproval?: boolean;
  providerOverride?: ProviderOverrideInput | null;
  userVercelAuth?: UserVercelAuth | null;
  githubToken?: string;
}

const uiAgentActionEnum = z.enum([
  'set-theme',
  'set-palette',
  'set-workbench-open',
  'set-workbench-tab',
  'set-model',
  'set-harness',
  'open-command-palette',
  'open-settings',
  'toggle-sidebar',
  'browser-navigate',
  'browser-take-control',
  'browser-release-control',
  'terminal-run',
  'new-chat',
  'ui-sdk-act',
]);

/**
 * Builds the complete AI SDK 7 ADE tool suite scoped to the current chat session,
 * sandbox workspace, browser session, artifact store, UI agent bridge, and optional GitHub SDK.
 */
export async function createAdeTools(options: CreateAdeToolsOptions): Promise<ToolSet> {
  const {
    chatId,
    userId,
    sandboxTier,
    enableUiBridge = true,
    uiActRequireApproval = true,
    providerOverride,
    userVercelAuth,
    githubToken,
  } = options;

  const bashToolkit = await createWorkspaceBashTool(chatId, {
    tier: sandboxTier,
  });

  const coreTools: ToolSet = {
    /* ---------------------------------------------------------------------- */
    /* Workspace / Coding Tools (bash-tool@1.3.19 + dual-tier sandbox)        */
    /* ---------------------------------------------------------------------- */
    bash: tool({
      description:
        'Execute a bash command inside the session workspace (Tier 1 just-bash or Tier 2 Vercel Sandbox). Destructive commands automatically request user approval via Sentinel.',
      inputSchema: z.object({
        command: z.string().min(1).describe('The shell command to run inside the workspace'),
      }),
      needsApproval: ({ command }) => isDestructiveCommand(command),
      execute: async ({ command }) => {
        const result = await bashToolkit.sandbox.executeCommand(command);
        const files = await listFiles(chatId, bashToolkit.tier);
        return {
          stdout: result.stdout.slice(0, 24_000),
          stderr: result.stderr.slice(0, 12_000),
          exitCode: result.exitCode,
          tier: bashToolkit.tier,
          fileCount: files.length,
          workbenchTab: 'terminal' as const,
        };
      },
    }),

    read_file: tool({
      description: 'Read a text file from the session workspace by relative path.',
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe('Relative workspace path, e.g. "src/hello.ts" or "index.html"'),
      }),
      execute: async ({ path }) => {
        try {
          const result = await readFile(chatId, path, bashToolkit.tier);
          return {
            ok: true,
            path: result.path,
            language: result.language,
            size: result.size,
            tier: result.tier,
            content: result.content.slice(0, 48_000),
          };
        } catch (error) {
          return {
            ok: false,
            path,
            error: error instanceof Error ? error.message : 'Unable to read file.',
          };
        }
      },
    }),

    write_file: tool({
      description: 'Create or overwrite a file in the session workspace.',
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe('Relative workspace path, e.g. "index.html" or "src/app.ts"'),
        content: z.string().describe('Complete UTF-8 file contents to write'),
      }),
      execute: async ({ path, content }) => {
        try {
          const result = await writeFile(chatId, path, content, bashToolkit.tier);
          return {
            ok: true,
            path: result.path,
            size: result.size,
            language: result.language,
            tier: result.tier,
            fileCount: result.files.length,
            workbenchTab: result.language === 'html' ? ('preview' as const) : ('files' as const),
          };
        } catch (error) {
          return {
            ok: false,
            path,
            error: error instanceof Error ? error.message : 'Unable to write file.',
          };
        }
      },
    }),

    list_files: tool({
      description: 'List all files currently persisted in the session workspace.',
      inputSchema: z.object({
        prefix: z.string().optional().describe('Optional path prefix filter, e.g. "src/"'),
      }),
      execute: async ({ prefix }) => {
        const files = await listFiles(chatId, bashToolkit.tier);
        const filtered = prefix
          ? files.filter((entry) => entry.path.startsWith(prefix.replace(/^\/+/, '')))
          : files;
        return {
          tier: bashToolkit.tier,
          count: filtered.length,
          files: filtered.map((f) => ({
            path: f.path,
            size: f.size,
            language: f.language,
          })),
        };
      },
    }),

    /* ---------------------------------------------------------------------- */
    /* Artifacts / Canvas (fx0 instant HTML preview, code, doc, genui, diff)  */
    /* ---------------------------------------------------------------------- */
    create_artifact: tool({
      description:
        'Create a persistent Workbench artifact. Use kind="html" for complete self-contained single-file interactive HTML previews (fx0 style), kind="code" for source files, kind="document" for rich specs/reports, kind="genui" for json-render specs, or kind="diff" for patches.',
      inputSchema: z.object({
        title: z.string().min(1).max(160),
        kind: z.enum(['code', 'document', 'html', 'genui', 'diff']),
        content: z
          .string()
          .describe('Full artifact content (HTML, code, markdown, diff, or JSON spec)'),
        language: z
          .string()
          .optional()
          .describe('Optional programming language hint, e.g. "typescript", "html"'),
        syncToWorkspaceIndex: z
          .boolean()
          .optional()
          .describe('When kind is "html", also write to workspace index.html (defaults to true)'),
      }),
      execute: async ({ title, kind, content, language, syncToWorkspaceIndex }) => {
        const saved = await saveArtifact({
          chatId,
          userId,
          title,
          kind,
          language:
            language ?? (kind === 'html' ? 'html' : kind === 'document' ? 'markdown' : undefined),
          content,
        });

        if (kind === 'html' && (syncToWorkspaceIndex ?? true)) {
          await writeFile(chatId, 'index.html', content, bashToolkit.tier).catch(() => undefined);
        }

        return {
          ok: true,
          artifact: saved,
          workbenchTab: artifactTabForKind(kind),
        };
      },
    }),

    update_artifact: tool({
      description: 'Save a new version of an existing Workbench artifact by ID.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Existing artifact ID returned by create_artifact'),
        title: z.string().min(1).max(160).optional(),
        kind: z.enum(['code', 'document', 'html', 'genui', 'diff']).optional(),
        content: z.string().describe('Complete updated content for the new artifact version'),
        language: z.string().optional(),
      }),
      execute: async ({ id, title, kind, content, language }) => {
        const existing = await getLatestArtifact(id);
        if (existing?.chatId && existing.chatId !== chatId) {
          return {
            ok: false,
            error: 'Forbidden: artifact belongs to a different chat session.',
          };
        }
        const resolvedKind: ArtifactKind = kind ?? existing?.kind ?? 'code';
        const resolvedTitle = title ?? existing?.title ?? 'Untitled Artifact';
        const resolvedLanguage = language ?? existing?.language;

        const saved = await saveArtifact({
          id,
          chatId,
          userId,
          title: resolvedTitle,
          kind: resolvedKind,
          language: resolvedLanguage,
          content,
        });

        if (resolvedKind === 'html') {
          await writeFile(chatId, 'index.html', content, bashToolkit.tier).catch(() => undefined);
        }

        return {
          ok: true,
          artifact: saved,
          workbenchTab: artifactTabForKind(resolvedKind),
        };
      },
    }),

    /* ---------------------------------------------------------------------- */
    /* Live Browser & Desktop Tools (lib/sandbox/browser-service.ts)          */
    /* ---------------------------------------------------------------------- */
    browser_open: tool({
      description:
        'Open a URL (or workspace://index.html) in the embedded ADE Browser pane and capture its interactive accessibility snapshot.',
      inputSchema: z.object({
        url: z.string().min(1).describe('Full http/https URL or "workspace://index.html"'),
        mode: z.enum(['preview', 'screen-relay', 'agent-browser', 'snapshot']).optional(),
      }),
      execute: async ({ url, mode }) => {
        const res = await browserOpen(chatId, url, { mode });
        return {
          ok: res.ok,
          mode: res.mode,
          backend: res.backend,
          url: res.url,
          title: res.title,
          snapshotTree: res.snapshotTree?.slice(0, 8_000),
          textSummary: res.textSummary?.slice(0, 4_000),
          linkCount: res.links?.length ?? 0,
          streamUrl: res.streamUrl,
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_snapshot: tool({
      description:
        'Capture an updated interactive accessibility tree snapshot (with @e1/@e2 element refs) of the currently open page.',
      inputSchema: z.object({
        interactive: z
          .boolean()
          .optional()
          .describe('Focus on interactive elements (default true)'),
        compact: z.boolean().optional().describe('Compact tree representation (default true)'),
      }),
      execute: async ({ interactive, compact }) => {
        const res = await browserSnapshot(chatId, { interactive, compact });
        return {
          ok: res.ok,
          url: res.url,
          title: res.title,
          backend: res.backend,
          snapshotTree: res.snapshotTree?.slice(0, 8_000),
          links: res.links?.slice(0, 25),
          inputs: res.inputs?.slice(0, 15),
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_click: tool({
      description:
        'Click an interactive element ref (e.g. "@e3"), selector, link text, or viewport coordinates.',
      inputSchema: z.object({
        target: z
          .string()
          .optional()
          .describe('Element ref like "@e1", CSS selector, or visible link text'),
        x: z
          .number()
          .optional()
          .describe('Optional viewport X coordinate when clicking by position'),
        y: z
          .number()
          .optional()
          .describe('Optional viewport Y coordinate when clicking by position'),
      }),
      execute: async ({ target, x, y }) => {
        const clickArg =
          target && target.trim().length > 0 ? target.trim() : { x: x ?? 0, y: y ?? 0 };
        const res = await browserClick(chatId, clickArg);
        return {
          ok: res.ok,
          url: res.url,
          title: res.title,
          snapshotTree: res.snapshotTree?.slice(0, 6_000),
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_fill: tool({
      description:
        'Fill a form input or textarea identified by element ref (e.g. "@e4") or CSS selector.',
      inputSchema: z.object({
        selector: z.string().min(1).describe('Element ref (e.g. "@e4") or CSS selector/name'),
        value: z.string().describe('Value to enter into the input'),
      }),
      execute: async ({ selector, value }) => {
        const res = await browserFill(chatId, selector, value);
        return {
          ok: res.ok,
          url: res.url,
          snapshotTree: res.snapshotTree?.slice(0, 6_000),
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_press: tool({
      description:
        'Send a keyboard key press (e.g. "Enter", "Tab", "Escape", "ArrowDown") to the browser.',
      inputSchema: z.object({
        key: z.string().min(1),
      }),
      execute: async ({ key }) => {
        const res = await browserPress(chatId, key);
        return {
          ok: res.ok,
          url: res.url,
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_scroll: tool({
      description: 'Scroll the active browser page in a direction by a pixel amount.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
        amount: z.number().int().min(50).max(4000).default(480),
      }),
      execute: async ({ direction, amount }) => {
        const res = await browserScroll(chatId, direction, amount);
        return {
          ok: res.ok,
          url: res.url,
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    browser_screenshot: tool({
      description:
        'Capture a screenshot of the currently active browser view or live desktop relay.',
      inputSchema: z.object({
        fullPage: z.boolean().optional(),
      }),
      execute: async ({ fullPage }) => {
        const res = await browserScreenshot(chatId, { fullPage });
        return {
          ok: res.ok,
          url: res.url,
          title: res.title,
          screenshotDataUrl: res.screenshotDataUrl,
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: {
          ok: output.ok,
          url: output.url,
          title: output.title ?? null,
          screenshotCaptured: Boolean(output.screenshotDataUrl),
          screenshotDataUrl: output.screenshotDataUrl?.startsWith('data:')
            ? '[inline screenshot rendered in UI; base64 omitted from model context]'
            : (output.screenshotDataUrl ?? null),
          statusMessage: output.statusMessage ?? null,
          error: output.error ?? null,
          workbenchTab: output.workbenchTab,
        },
      }),
    }),

    browser_read: tool({
      description:
        'Extract clean readable text content from the current browser page or a given URL.',
      inputSchema: z.object({
        url: z.string().optional().describe('Optional URL to navigate to before reading'),
      }),
      execute: async ({ url }) => {
        const res = await browserRead(chatId, url);
        return {
          ok: res.ok,
          url: res.url,
          title: res.title,
          textSummary: res.textSummary?.slice(0, 8_000),
          linkCount: res.links?.length ?? 0,
          statusMessage: res.statusMessage,
          error: res.error,
          workbenchTab: 'browser' as const,
        };
      },
    }),

    /* ---------------------------------------------------------------------- */
    /* Clarifying Questions (Client-Executed Structured Questionnaire)        */
    /* ---------------------------------------------------------------------- */
    ask_user: tool({
      description:
        'Ask the user 1-3 concise multiple-choice clarifying questions when requirements are genuinely ambiguous. Wait for the user to select answers in the inline card.',
      inputSchema: z.object({
        title: z.string().optional().describe('Short heading for the questionnaire card'),
        questions: z
          .array(
            z.object({
              id: z.string().min(1),
              prompt: z.string().min(1),
              multiSelect: z.boolean().optional(),
              options: z
                .array(
                  z.object({
                    id: z.string().min(1),
                    label: z.string().min(1),
                    description: z.string().optional(),
                  }),
                )
                .min(2)
                .max(6),
            }),
          )
          .min(1)
          .max(4),
      }),
    }),

    /* ---------------------------------------------------------------------- */
    /* Multimodal Image Generation (OpenAI GPT Image 2)                       */
    /* ---------------------------------------------------------------------- */
    generate_image: tool({
      description:
        'Generate a high-craft image from a text prompt using OpenAI GPT Image 2, returning a displayable URL.',
      inputSchema: z.object({
        prompt: z
          .string()
          .min(3)
          .max(2000)
          .describe('Detailed visual description of the image to generate'),
        aspectRatio: z
          .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
          .optional()
          .describe('Desired aspect ratio (default 1:1)'),
        modelId: z.string().optional().describe('Optional image model override'),
      }),
      execute: async ({ prompt, aspectRatio = '1:1', modelId }) => {
        const runGeneration = async (skipUserToken: boolean) => {
          const resolved = await resolveImageGenerator({
            modelId,
            override: providerOverride,
            userVercelAuth,
            skipUserToken,
          });

          let imageBytes: Uint8Array | null = null;
          let mediaType = 'image/png';

          if (resolved.kind === 'language-files') {
            const gen = await generateText({
              model: resolved.model,
              prompt: `Generate a high quality image (${aspectRatio}): ${prompt}`,
            });
            const imageFile = gen.files?.find((file) => file.mediaType.startsWith('image/'));
            if (imageFile) {
              imageBytes = imageFile.uint8Array;
              mediaType = imageFile.mediaType;
            }
          } else {
            const gen = await generateImage({
              model: resolved.model,
              prompt,
              aspectRatio,
            });
            if (gen.image) {
              imageBytes = gen.image.uint8Array;
              mediaType = gen.image.mediaType || 'image/png';
            }
          }

          return { resolved, imageBytes, mediaType };
        };

        try {
          let outcome: Awaited<ReturnType<typeof runGeneration>>;
          try {
            outcome = await runGeneration(false);
          } catch (error) {
            if (userVercelAuth?.accessToken && isUserTokenBillingError(error)) {
              invalidateVercelGatewayCreditsCache(userVercelAuth.accessToken);
              outcome = await runGeneration(true);
            } else {
              throw error;
            }
          }

          const { resolved, imageBytes, mediaType } = outcome;
          if (!imageBytes || imageBytes.byteLength === 0) {
            return {
              ok: false,
              error: 'The image provider did not return an image payload.',
              modelId: resolved.modelId,
              billingSource: resolved.billingSource,
            };
          }

          const ext = mediaType.includes('jpeg')
            ? 'jpg'
            : mediaType.includes('webp')
              ? 'webp'
              : 'png';

          let url: string;
          let storage: 'vercel-blob' | 'data-url' = 'data-url';

          if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
            const filename = sanitizeFilename(`generated-${generateId('img', 8)}.${ext}`);
            const blob = await put(`ade/images/${filename}`, Buffer.from(imageBytes), {
              access: 'public',
              contentType: mediaType,
              addRandomSuffix: true,
            });
            url = blob.url;
            storage = 'vercel-blob';
          } else {
            url = `data:${mediaType};base64,${Buffer.from(imageBytes).toString('base64')}`;
          }

          return {
            ok: true,
            url,
            mediaType,
            storage,
            prompt,
            aspectRatio,
            modelId: resolved.modelId,
            billingSource: resolved.billingSource,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Image generation failed.',
          };
        }
      },
      toModelOutput: ({ output }) => {
        if (!output.ok) {
          return {
            type: 'json',
            value: {
              ok: false,
              error: output.error ?? 'Image generation failed.',
              modelId: output.modelId ?? null,
              billingSource: output.billingSource ?? null,
            },
          };
        }

        return {
          type: 'json',
          value: {
            ok: true,
            url: output.url?.startsWith('data:')
              ? '[inline generated image rendered directly in UI; base64 omitted from model context]'
              : (output.url ?? null),
            mediaType: output.mediaType ?? 'image/png',
            storage: output.storage ?? 'data-url',
            prompt: output.prompt ?? '',
            aspectRatio: output.aspectRatio ?? '1:1',
            modelId: output.modelId ?? null,
            billingSource: output.billingSource ?? null,
          },
        };
      },
    }),

    /* ---------------------------------------------------------------------- */
    /* Safe Web Fetch (DNS SSRF-protected + bounded 512 KB streaming read)    */
    /* ---------------------------------------------------------------------- */
    web_fetch: tool({
      description:
        'Fetch a public HTTP/HTTPS URL and extract clean readable text/markdown (DNS SSRF-protected, manual redirect validation, 512 KB streaming cap).',
      inputSchema: z.object({
        url: z.string().min(1).describe('Public http:// or https:// URL to fetch'),
        maxChars: z.number().int().min(500).max(24_000).default(12_000),
      }),
      execute: async ({ url, maxChars }) => {
        try {
          const { response, finalUrl } = await safeExternalFetch(url, {
            method: 'GET',
            headers: {
              'User-Agent': 'WebADE/1.0 (+https://github.com/markeljan/web-ade)',
              Accept: 'text/html, text/plain, text/markdown, application/json;q=0.9',
            },
            maxRedirects: 5,
            timeoutMs: 10_000,
          });

          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return {
              ok: false,
              url: finalUrl,
              status: response.status,
              error: `HTTP ${response.status} ${response.statusText}`,
            };
          }

          const contentType = response.headers.get('content-type') ?? '';
          const rawText = await readResponseTextBounded(response, MAX_WEB_FETCH_BYTES);

          if (
            contentType.includes('text/html') ||
            /<!doctype html|<html\b/i.test(rawText.slice(0, 500))
          ) {
            const { title, text } = htmlToReadableText(rawText);
            return {
              ok: true,
              url: finalUrl,
              status: response.status,
              contentType,
              title,
              truncated: text.length > maxChars,
              content: text.slice(0, maxChars),
            };
          }

          return {
            ok: true,
            url: finalUrl,
            status: response.status,
            contentType,
            truncated: rawText.length > maxChars,
            content: rawText.slice(0, maxChars),
          };
        } catch (error) {
          return {
            ok: false,
            url,
            error: error instanceof Error ? error.message : 'Network fetch failed.',
          };
        }
      },
    }),
  };

  /* ------------------------------------------------------------------------ */
  /* Self-Operating ADE UI Bridge (@ui-sdk/react/agent — Client-Executed)     */
  /* ------------------------------------------------------------------------ */
  if (enableUiBridge) {
    coreTools.ui_snapshot = tool({
      description:
        'Inspect the live Web ADE user interface state (theme, Astryx palette, model, harness, open Workbench tab, sidebar, and registered @ui-sdk/react/agent semantic controls). Executed client-side.',
      inputSchema: z.object({
        includeComponents: z
          .boolean()
          .optional()
          .describe('Include the list of registered semantic UI component refs (default true)'),
      }),
    });

    coreTools.ui_act = tool({
      description:
        'Operate Web ADE UI controls directly via @ui-sdk/react/agent (switch theme/palette, open/switch Workbench tabs, change model/harness, navigate embedded browser, toggle sidebar, open settings/command palette). Respects Sentinel human-in-the-loop approval preference.',
      inputSchema: z.object({
        reason: z
          .string()
          .min(1)
          .describe('Clear human-readable explanation of why these UI changes are helpful'),
        commands: z
          .array(
            z.object({
              action: uiAgentActionEnum,
              ref: z
                .string()
                .optional()
                .describe('Optional semantic @ui-sdk/react/agent component ref'),
              args: z.record(z.string(), z.unknown()).optional(),
              reason: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
      }),
      needsApproval: uiActRequireApproval,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Optional GitHub Tools (@github-tools/sdk — when user supplies PAT)       */
  /* ------------------------------------------------------------------------ */
  const trimmedGithubToken = githubToken?.trim() || providerOverride?.githubToken?.trim();
  if (trimmedGithubToken) {
    try {
      const ghTools = createGithubTools({
        token: trimmedGithubToken,
        preset: 'repo-explorer',
      });
      Object.assign(coreTools, ghTools);
    } catch {
      // Degrade cleanly if GitHub token fails SDK initialization.
    }
  }

  return coreTools;
}
