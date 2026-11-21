import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from 'mcp-handler';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isDestructiveCommand } from '@/lib/ai/tools/index';
import { getServerSession } from '@/lib/auth/session';
import { getChatById } from '@/lib/db/queries';
import { browserOpen } from '@/lib/sandbox/browser-service';
import { execCommand, listFiles, readFile, writeFile } from '@/lib/sandbox/manager';

export const maxDuration = 60;

interface McpRequestContext {
  authorizedByMcpToken: boolean;
  sessionUserId: string;
  isAuthenticated: boolean;
}

const mcpRequestStorage = new AsyncLocalStorage<McpRequestContext>();

function verifyBearerToken(authHeader: string | null, expectedToken: string): boolean {
  if (!authHeader) {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match?.[1]) {
    return false;
  }
  const providedHash = createHash('sha256').update(match[1].trim()).digest();
  const expectedHash = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Fail-closed authorization guard for remote MCP workspace tools:
 * - Valid `ADE_MCP_TOKEN` Bearer auth grants scoped server-to-server access.
 * - Without `ADE_MCP_TOKEN`:
 *   - `'default'` (or omitted `chatId`) is isolated per caller as `default:${session.userId}`.
 *   - Mutating tools (`workspace_write_file`, `workspace_bash`) require an authenticated
 *     session owner (never unauthenticated callers, never another user's public chat,
 *     and never nonexistent/unowned arbitrary chat IDs).
 *   - Read tools fail-closed on DB errors and forbid accessing nonexistent/unowned or
 *     another user's private chats.
 */
async function authorizeWorkspaceChatAccess(
  rawChatId: string | undefined,
  mode: 'read' | 'write',
): Promise<{ ok: true; chatId: string } | { ok: false; error: string }> {
  const ctx = mcpRequestStorage.getStore();
  if (!ctx) {
    return { ok: false, error: 'Unauthorized: missing MCP request context.' };
  }

  const trimmed = rawChatId?.trim();
  const isDefaultWorkspace = !trimmed || trimmed === 'default';

  if (ctx.authorizedByMcpToken) {
    return { ok: true, chatId: isDefaultWorkspace ? 'default' : trimmed };
  }

  if (isDefaultWorkspace) {
    if (mode === 'write' && !ctx.isAuthenticated) {
      return {
        ok: false,
        error:
          'Forbidden: mutating MCP tools require valid Bearer ADE_MCP_TOKEN or an authenticated session.',
      };
    }
    return { ok: true, chatId: `default:${ctx.sessionUserId}` };
  }

  let existingChat: Awaited<ReturnType<typeof getChatById>>;
  try {
    existingChat = await getChatById(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Unable to verify chat workspace ownership (storage error).',
    };
  }

  if (!existingChat) {
    return {
      ok: false,
      error: 'Forbidden: target chat workspace does not exist or requires Bearer ADE_MCP_TOKEN.',
    };
  }

  if (mode === 'write') {
    if (!ctx.isAuthenticated || existingChat.userId !== ctx.sessionUserId) {
      return {
        ok: false,
        error:
          'Forbidden: mutating a chat workspace requires the authenticated chat owner or Bearer ADE_MCP_TOKEN.',
      };
    }
    return { ok: true, chatId: trimmed };
  }

  if (existingChat.visibility !== 'public' && existingChat.userId !== ctx.sessionUserId) {
    return {
      ok: false,
      error:
        'Forbidden: private chat workspace requires matching session auth or Bearer ADE_MCP_TOKEN.',
    };
  }

  return { ok: true, chatId: trimmed };
}

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'workspace_list_files',
      {
        title: 'List Workspace Files',
        description:
          'List files in a Web ADE session workspace (defaults to caller-scoped workspace).',
        inputSchema: z.object({
          chatId: z
            .string()
            .optional()
            .describe('ADE session/chat ID (defaults to caller workspace)'),
        }),
      },
      async ({ chatId }) => {
        const auth = await authorizeWorkspaceChatAccess(chatId, 'read');
        if (!auth.ok) {
          return { isError: true, content: [{ type: 'text', text: auth.error }] };
        }

        const files = await listFiles(auth.chatId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chatId: auth.chatId,
                  count: files.length,
                  files: files.map((f) => ({
                    path: f.path,
                    size: f.size,
                    language: f.language,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      'workspace_read_file',
      {
        title: 'Read Workspace File',
        description: 'Read a text file from a Web ADE session workspace.',
        inputSchema: z.object({
          chatId: z
            .string()
            .optional()
            .describe('ADE session/chat ID (defaults to caller workspace)'),
          path: z.string().min(1).describe('Relative workspace path, e.g. "README.md"'),
        }),
      },
      async ({ chatId, path }) => {
        const auth = await authorizeWorkspaceChatAccess(chatId, 'read');
        if (!auth.ok) {
          return { isError: true, content: [{ type: 'text', text: auth.error }] };
        }

        try {
          const result = await readFile(auth.chatId, path);
          return {
            content: [
              {
                type: 'text',
                text: result.content,
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : 'Unable to read workspace file.',
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      'workspace_write_file',
      {
        title: 'Write Workspace File',
        description:
          'Create or update a file inside a Web ADE session workspace (requires owner auth or ADE_MCP_TOKEN).',
        inputSchema: z.object({
          chatId: z
            .string()
            .optional()
            .describe('ADE session/chat ID (defaults to caller workspace)'),
          path: z.string().min(1).describe('Relative workspace file path'),
          content: z.string().describe('UTF-8 content to write'),
        }),
      },
      async ({ chatId, path, content }) => {
        const auth = await authorizeWorkspaceChatAccess(chatId, 'write');
        if (!auth.ok) {
          return { isError: true, content: [{ type: 'text', text: auth.error }] };
        }

        try {
          const result = await writeFile(auth.chatId, path, content);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    path: result.path,
                    size: result.size,
                    language: result.language,
                    tier: result.tier,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : 'Unable to write workspace file.',
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      'workspace_bash',
      {
        title: 'Run Workspace Shell Command',
        description:
          'Run a non-destructive shell command in the Web ADE workspace (requires owner auth or ADE_MCP_TOKEN; destructive commands are blocked).',
        inputSchema: z.object({
          chatId: z
            .string()
            .optional()
            .describe('ADE session/chat ID (defaults to caller workspace)'),
          command: z.string().min(1).describe('Shell command to execute'),
          cwd: z.string().optional().describe('Optional relative working directory'),
        }),
      },
      async ({ chatId, command, cwd }) => {
        if (isDestructiveCommand(command)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Blocked destructive command over remote MCP ("${command}"). Execute destructive commands inside the Web ADE UI with Sentinel approval.`,
              },
            ],
          };
        }

        const auth = await authorizeWorkspaceChatAccess(chatId, 'write');
        if (!auth.ok) {
          return { isError: true, content: [{ type: 'text', text: auth.error }] };
        }

        const result = await execCommand(auth.chatId, command, { cwd });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  exitCode: result.exitCode,
                  tier: result.tier,
                  durationMs: result.durationMs,
                  stdout: result.stdout.slice(0, 20_000),
                  stderr: result.stderr.slice(0, 10_000),
                  changedFiles: result.changedFiles,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      'browser_open_and_snapshot',
      {
        title: 'Open URL & Capture Snapshot',
        description:
          'Navigate the Web ADE embedded browser to a public URL (or workspace://index.html) and return its accessibility tree snapshot and readable summary.',
        inputSchema: z.object({
          chatId: z
            .string()
            .optional()
            .describe('ADE session/chat ID (defaults to caller workspace)'),
          url: z.string().min(1).describe('Public http(s) URL or "workspace://index.html"'),
        }),
      },
      async ({ chatId, url }) => {
        const auth = await authorizeWorkspaceChatAccess(chatId, 'read');
        if (!auth.ok) {
          return { isError: true, content: [{ type: 'text', text: auth.error }] };
        }

        const result = await browserOpen(auth.chatId, url);
        return {
          isError: !result.ok,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: result.ok,
                  url: result.url,
                  title: result.title,
                  mode: result.mode,
                  backend: result.backend,
                  snapshotTree: result.snapshotTree?.slice(0, 10_000),
                  textSummary: result.textSummary?.slice(0, 5_000),
                  error: result.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  },
  {
    serverInfo: {
      name: 'web-ade',
      version: '0.1.0',
    },
  },
);

async function handleMcpRequest(request: Request): Promise<Response> {
  const configuredToken = process.env.ADE_MCP_TOKEN?.trim();
  const authorizedByMcpToken = configuredToken
    ? verifyBearerToken(request.headers.get('authorization'), configuredToken)
    : false;

  if (configuredToken && !authorizedByMcpToken) {
    return NextResponse.json(
      { error: 'Unauthorized: valid Bearer token required for /api/mcp.' },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="web-ade-mcp"' },
      },
    );
  }

  const session = await getServerSession(request.headers);
  return mcpRequestStorage.run(
    {
      authorizedByMcpToken,
      sessionUserId: session.userId,
      isAuthenticated: session.isAuthenticated,
    },
    () => baseHandler(request),
  );
}

export { handleMcpRequest as GET, handleMcpRequest as POST, handleMcpRequest as DELETE };
