import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GET as getResumeStream } from '@/app/api/chat/[id]/stream/route';
import { POST as rewindChatRoute } from '@/app/api/chats/[id]/rewind/route';
import { POST as createChatRoute, GET as listChatsRoute } from '@/app/api/chats/route';
import { POST as mcpRoute } from '@/app/api/mcp/route';
import {
  GET as getProviderStatusRoute,
  POST as postProviderStatusRoute,
} from '@/app/api/provider/status/route';
import { POST as execSandboxRoute } from '@/app/api/sandbox/exec/route';
import {
  DELETE as deleteSandboxFileRoute,
  GET as getSandboxFilesRoute,
  POST as postSandboxFilesRoute,
} from '@/app/api/sandbox/files/route';
import { POST as postRelayGrantRoute } from '@/app/api/sandbox/relay-grant/route';
import { GET as getSandboxRoute, POST as postSandboxRoute } from '@/app/api/sandbox/route';
import { POST as postUploadRoute } from '@/app/api/upload/route';
import {
  DELETE as deleteWorkflowRunRoute,
  GET as getWorkflowRunRoute,
} from '@/app/api/workflow/[runId]/route';
import type { LocalStoreData } from '@/lib/db/local-store';
import { createChat, saveMessages } from '@/lib/db/queries';
import { registerWorkspacePersistence } from '@/lib/sandbox/manager';

interface GlobalLocalStoreState {
  __minimalAdeLocalStore?: LocalStoreData;
  __minimalAdeLocalStoreLoaded?: boolean;
  __minimalAdeLocalStorePath?: string;
  __minimalAdeLocalStoreReadOnly?: boolean;
  __minimalAdeLocalStoreQueue?: Promise<unknown>;
}

const ENV_KEYS = [
  'DATABASE_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SCREEN_RELAY_URL',
  'SCREEN_RELAY_TOKEN',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const globalState = globalThis as unknown as GlobalLocalStoreState;
let savedEnv: Partial<Record<EnvKey, string | undefined>> = {};
let savedGlobalStore: GlobalLocalStoreState;
let tempDir = '';

async function parseMcpBody(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!line) throw new Error(`Missing SSE data line: ${text}`);
    return JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Next.js API route handler integration smoke tests', () => {
  beforeEach(async () => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    savedGlobalStore = {
      __minimalAdeLocalStore: globalState.__minimalAdeLocalStore,
      __minimalAdeLocalStoreLoaded: globalState.__minimalAdeLocalStoreLoaded,
      __minimalAdeLocalStorePath: globalState.__minimalAdeLocalStorePath,
      __minimalAdeLocalStoreReadOnly: globalState.__minimalAdeLocalStoreReadOnly,
      __minimalAdeLocalStoreQueue: globalState.__minimalAdeLocalStoreQueue,
    };

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'minimal-ade-api-routes-'));
    globalState.__minimalAdeLocalStore = {
      chats: {},
      messages: {},
      votes: {},
      artifacts: {},
      workspaceFiles: {},
    };
    globalState.__minimalAdeLocalStoreLoaded = true;
    globalState.__minimalAdeLocalStorePath = path.join(tempDir, 'store.json');
    globalState.__minimalAdeLocalStoreReadOnly = false;
    globalState.__minimalAdeLocalStoreQueue = undefined;

    registerWorkspacePersistence(null);
  });

  afterEach(async () => {
    await globalState.__minimalAdeLocalStoreQueue?.catch(() => undefined);

    delete (globalThis as Record<string, unknown>).__minimalAdeDbAdapter;
    globalState.__minimalAdeLocalStore = savedGlobalStore.__minimalAdeLocalStore;
    globalState.__minimalAdeLocalStoreLoaded = savedGlobalStore.__minimalAdeLocalStoreLoaded;
    globalState.__minimalAdeLocalStorePath = savedGlobalStore.__minimalAdeLocalStorePath;
    globalState.__minimalAdeLocalStoreReadOnly = savedGlobalStore.__minimalAdeLocalStoreReadOnly;
    globalState.__minimalAdeLocalStoreQueue = savedGlobalStore.__minimalAdeLocalStoreQueue;

    for (const key of ENV_KEYS) {
      const prev = savedEnv[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('/api/provider/status handles GET, POST override, and malformed JSON', async () => {
    const getRes = await getProviderStatusRoute(
      new Request('http://localhost:3000/api/provider/status'),
    );
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as {
      models: Array<{ id: string; provider: string; sponsoredEligible?: boolean }>;
      activeBillingSource: string;
      diagnostics: { tiers: unknown[]; sponsoredOnlyModels: boolean };
    };
    expect(Array.isArray(getData.models)).toBe(true);
    expect(getData.models.length).toBe(8);
    expect(getData.models.every((m) => m.provider === 'openai' || m.provider === 'anthropic')).toBe(
      true,
    );
    expect(getData.models.filter((m) => m.sponsoredEligible).map((m) => m.id)).toEqual([
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6-luna',
    ]);
    expect(getData.diagnostics.tiers.length).toBe(6);

    const postRes = await postProviderStatusRoute(
      new Request('http://localhost:3000/api/provider/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'custom-openai-compatible',
          customBaseUrl: 'http://localhost:11434/v1',
          customModel: 'llama4:latest',
        }),
      }),
    );
    expect(postRes.status).toBe(200);
    const postData = (await postRes.json()) as {
      activeBillingSource: string;
      defaultModelId: string;
    };
    expect(postData.activeBillingSource).toBe('custom-endpoint');
    expect(postData.defaultModelId).toBe('llama4:latest');

    const badJsonRes = await postProviderStatusRoute(
      new Request('http://localhost:3000/api/provider/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      }),
    );
    expect(badJsonRes.status).toBe(400);
  });

  it('/api/chats creates and lists chats cleanly with validation', async () => {
    const guestHeaders = {
      'content-type': 'application/json',
      'x-ade-guest-id': 'guest_route_smoke_1',
    };

    const createRes = await createChatRoute(
      new Request('http://localhost:3000/api/chats', {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({
          title: 'Integration Route Chat',
          harnessMode: 'ai-sdk',
          modelId: 'openai/gpt-6.2-sol',
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { chat: { id: string; title: string } };
    expect(created.chat.title).toBe('Integration Route Chat');

    const listRes = await listChatsRoute(
      new Request('http://localhost:3000/api/chats?search=Integration', {
        headers: { 'x-ade-guest-id': 'guest_route_smoke_1' },
      }),
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { chats: Array<{ id: string }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.chats[0]?.id).toBe(created.chat.id);

    const invalidRes = await createChatRoute(
      new Request('http://localhost:3000/api/chats', {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ harnessMode: 'unknown-harness' }),
      }),
    );
    expect(invalidRes.status).toBe(400);

    // Duplicate explicit ID MUST return 409 Conflict
    const dupRes = await createChatRoute(
      new Request('http://localhost:3000/api/chats', {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ id: created.chat.id, title: 'Duplicate' }),
      }),
    );
    expect(dupRes.status).toBe(409);

    // Server Rewind route persists message truncation for owner and blocks foreign users (403)
    await saveMessages(created.chat.id, [
      {
        id: 'rw-1',
        role: 'user',
        parts: [{ type: 'text', text: 'First' }],
        createdAt: new Date('2026-11-19T12:00:00Z'),
      },
      {
        id: 'rw-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Second' }],
        createdAt: new Date('2026-11-19T12:00:01Z'),
      },
    ]);

    const foreignRewind = await rewindChatRoute(
      new Request(`http://localhost:3000/api/chats/${created.chat.id}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ade-guest-id': 'guest_other_user_99' },
        body: JSON.stringify({ messageId: 'rw-1' }),
      }),
      { params: Promise.resolve({ id: created.chat.id }) },
    );
    expect(foreignRewind.status).toBe(403);

    const ownerRewind = await rewindChatRoute(
      new Request(`http://localhost:3000/api/chats/${created.chat.id}/rewind`, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ messageId: 'rw-1', inclusive: false }),
      }),
      { params: Promise.resolve({ id: created.chat.id }) },
    );
    expect(ownerRewind.status).toBe(200);
    const rewound = (await ownerRewind.json()) as { rewound: boolean; deletedCount: number };
    expect(rewound.rewound).toBe(true);
    expect(rewound.deletedCount).toBe(1);
  });

  it('/api/sandbox returns status, starter files, and validates actions', async () => {
    const chatId = `route-sbx-${Date.now()}`;

    const getRes = await getSandboxRoute(
      new Request(`http://localhost:3000/api/sandbox?chatId=${chatId}`),
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      status: { tier: string; fileCount: number };
      files: Array<{ path: string }>;
      browser: { mode: string };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.status.tier).toBe('just-bash');
    expect(getBody.status.fileCount).toBeGreaterThanOrEqual(4);
    expect(getBody.browser.mode).toBe('preview');

    const postRes = await postSandboxRoute(
      new Request('http://localhost:3000/api/sandbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'status' }),
      }),
    );
    expect(postRes.status).toBe(200);
    expect(((await postRes.json()) as { ok: boolean }).ok).toBe(true);

    const badRes = await postSandboxRoute(
      new Request('http://localhost:3000/api/sandbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'not-a-valid-action' }),
      }),
    );
    expect(badRes.status).toBe(400);

    // Host-billed Tier 2 cloud upgrade rejects unowned/nonexistent chatId with 403
    const unownedUpgradeRes = await postSandboxRoute(
      new Request('http://localhost:3000/api/sandbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ade-guest-id': 'guest_unowned_1' },
        body: JSON.stringify({ chatId: 'nonexistent-chat-id', action: 'upgrade' }),
      }),
    );
    expect(unownedUpgradeRes.status).toBe(403);
  });

  it('/api/sandbox/exec executes shell commands and syncs file changes', async () => {
    const chatId = `route-exec-${Date.now()}`;

    const execRes = await execSandboxRoute(
      new Request('http://localhost:3000/api/sandbox/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId,
          tier: 'just-bash',
          command: 'echo "route-ok" && echo "hello" > api-created.txt',
        }),
      }),
    );
    expect(execRes.status).toBe(200);
    const body = (await execRes.json()) as {
      ok: boolean;
      stdout: string;
      exitCode: number;
      changedFiles: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout.trim()).toBe('route-ok');
    expect(body.changedFiles).toContain('api-created.txt');

    const emptyCmdRes = await execSandboxRoute(
      new Request('http://localhost:3000/api/sandbox/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, command: '' }),
      }),
    );
    expect(emptyCmdRes.status).toBe(400);
  });

  it('/api/sandbox/files supports write, read, list, delete, and 404 on missing files', async () => {
    const chatId = `route-files-${Date.now()}`;

    const writeRes = await postSandboxFilesRoute(
      new Request('http://localhost:3000/api/sandbox/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId,
          path: 'notes/smoke.txt',
          content: 'smoke content',
        }),
      }),
    );
    expect(writeRes.status).toBe(200);

    const readRes = await getSandboxFilesRoute(
      new Request(`http://localhost:3000/api/sandbox/files?chatId=${chatId}&path=notes/smoke.txt`),
    );
    expect(readRes.status).toBe(200);
    const readData = (await readRes.json()) as { ok: boolean; file: { content: string } };
    expect(readData.ok).toBe(true);
    expect(readData.file.content).toBe('smoke content');

    const listRes = await getSandboxFilesRoute(
      new Request(`http://localhost:3000/api/sandbox/files?chatId=${chatId}`),
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { paths: string[] };
    expect(listData.paths).toContain('notes/smoke.txt');

    const delRes = await deleteSandboxFileRoute(
      new Request(`http://localhost:3000/api/sandbox/files?chatId=${chatId}&path=notes/smoke.txt`, {
        method: 'DELETE',
      }),
    );
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { deleted: boolean }).deleted).toBe(true);

    const missingRes = await getSandboxFilesRoute(
      new Request(`http://localhost:3000/api/sandbox/files?chatId=${chatId}&path=notes/smoke.txt`),
    );
    expect(missingRes.status).toBe(404);
  });

  it('/api/sandbox/relay-grant validates input and degrades safely without leaking tokens', async () => {
    const secretToken = 'cafe1234'.repeat(8);
    process.env.SCREEN_RELAY_URL = 'http://127.0.0.1:19999';
    process.env.SCREEN_RELAY_TOKEN = secretToken;

    const res = await postRelayGrantRoute(
      new Request('http://localhost:3000/api/sandbox/relay-grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'relay-smoke', role: 'watch', ttlSec: 60 }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secretToken);

    const badRoleRes = await postRelayGrantRoute(
      new Request('http://localhost:3000/api/sandbox/relay-grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      }),
    );
    expect(badRoleRes.status).toBe(400);
  });

  it('/api/chat/[id]/stream returns HTTP 204 cleanly when Upstash Redis is absent', async () => {
    const res = await getResumeStream(
      new Request('http://localhost:3000/api/chat/chat-no-redis/stream'),
      { params: Promise.resolve({ id: 'chat-no-redis' }) },
    );
    expect(res.status).toBe(204);
  });

  it('/api/mcp responds to Streamable HTTP tools/list with 200 OK and blocks unauthenticated mutations on foreign public chats', async () => {
    const res = await mcpRoute(
      new Request('http://localhost:3000/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/list',
          params: {},
        }),
      }),
    );
    expect(res.status).toBe(200);
    const payload = await parseMcpBody(res);
    const tools = (payload.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    expect(tools.length).toBe(5);

    // Create a public chat owned by another user and verify unauthenticated MCP write fails closed
    const publicChat = await createChat({
      id: 'chat-public-victim',
      userId: 'owner_user_1',
      title: 'Public Showcase Chat',
      visibility: 'public',
    });

    const writeRes = await mcpRoute(
      new Request('http://localhost:3000/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-ade-guest-id': 'guest_attacker_2',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'workspace_write_file',
            arguments: {
              chatId: publicChat.id,
              path: 'pwned.txt',
              content: 'unauthorized write',
            },
          },
        }),
      }),
    );
    expect(writeRes.status).toBe(200);
    const writePayload = await parseMcpBody(writeRes);
    const writeResult = writePayload.result as { isError?: boolean };
    expect(writeResult.isError).toBe(true);
  });

  it('/api/upload rejects active HTML and SVG uploads with HTTP 415', async () => {
    const htmlForm = new FormData();
    htmlForm.append(
      'file',
      new File(['<script>alert(1)</script>'], 'xss.html', { type: 'text/html' }),
    );
    const htmlRes = await postUploadRoute(
      new Request('http://localhost:3000/api/upload', {
        method: 'POST',
        headers: { 'x-ade-guest-id': 'guest_upload_1' },
        body: htmlForm,
      }),
    );
    expect(htmlRes.status).toBe(415);

    const svgForm = new FormData();
    svgForm.append(
      'file',
      new File(['<svg onload="alert(1)"/>'], 'vector.svg', { type: 'image/svg+xml' }),
    );
    const svgRes = await postUploadRoute(
      new Request('http://localhost:3000/api/upload', {
        method: 'POST',
        headers: { 'x-ade-guest-id': 'guest_upload_1' },
        body: svgForm,
      }),
    );
    expect(svgRes.status).toBe(415);
  });

  it('/api/workflow/[runId] blocks unauthorized GET and DELETE with HTTP 403', async () => {
    const getRes = await getWorkflowRunRoute(
      new Request('http://localhost:3000/api/workflow/nonexistent-run', {
        headers: { 'x-ade-guest-id': 'guest_wf_unauth' },
      }),
      { params: Promise.resolve({ runId: 'nonexistent-run' }) },
    );
    expect(getRes.status).toBe(403);

    const delRes = await deleteWorkflowRunRoute(
      new Request('http://localhost:3000/api/workflow/nonexistent-run', {
        method: 'DELETE',
        headers: { 'x-ade-guest-id': 'guest_wf_unauth' },
      }),
      { params: Promise.resolve({ runId: 'nonexistent-run' }) },
    );
    expect(delRes.status).toBe(403);
  });
});
