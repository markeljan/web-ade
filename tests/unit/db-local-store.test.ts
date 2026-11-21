import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDbOrNull, isDatabaseConfigured } from '@/lib/db/index';
import type { LocalStoreData } from '@/lib/db/local-store';
import {
  ChatAlreadyExistsError,
  createChat,
  deleteArtifact,
  deleteChat,
  deleteMessagesAfter,
  deleteWorkspaceFile,
  ensureChat,
  getArtifactVersions,
  getChatById,
  getLatestArtifact,
  getMessagesByChatId,
  getVotesByChatId,
  getWorkspaceFiles,
  getWorkspaceFilesMap,
  listArtifactsByChatId,
  listChats,
  normalizeWorkspacePath,
  saveArtifact,
  saveMessages,
  syncWorkspaceFiles,
  transferUserOwnership,
  updateChat,
  upsertWorkspaceFile,
  voteMessage,
} from '@/lib/db/queries';

interface GlobalLocalStoreState {
  __webAdeLocalStore?: LocalStoreData;
  __webAdeLocalStoreLoaded?: boolean;
  __webAdeLocalStorePath?: string;
  __webAdeLocalStoreReadOnly?: boolean;
  __webAdeLocalStoreQueue?: Promise<unknown>;
}

const globalState = globalThis as unknown as GlobalLocalStoreState;

let savedDatabaseUrl: string | undefined;
let savedGlobalStore: GlobalLocalStoreState;
let tempDir = '';
let tempStorePath = '';

describe('local fallback store (zero-DB CRUD, branching, artifacts, workspace sync)', () => {
  beforeEach(async () => {
    savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    savedGlobalStore = {
      __webAdeLocalStore: globalState.__webAdeLocalStore,
      __webAdeLocalStoreLoaded: globalState.__webAdeLocalStoreLoaded,
      __webAdeLocalStorePath: globalState.__webAdeLocalStorePath,
      __webAdeLocalStoreReadOnly: globalState.__webAdeLocalStoreReadOnly,
      __webAdeLocalStoreQueue: globalState.__webAdeLocalStoreQueue,
    };

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'web-ade-local-store-'));
    tempStorePath = path.join(tempDir, 'store.json');

    globalState.__webAdeLocalStore = {
      chats: {},
      messages: {},
      votes: {},
      artifacts: {},
      workspaceFiles: {},
    };
    globalState.__webAdeLocalStoreLoaded = true;
    globalState.__webAdeLocalStorePath = tempStorePath;
    globalState.__webAdeLocalStoreReadOnly = false;
    globalState.__webAdeLocalStoreQueue = undefined;
  });

  afterEach(async () => {
    await globalState.__webAdeLocalStoreQueue?.catch(() => undefined);

    globalState.__webAdeLocalStore = savedGlobalStore.__webAdeLocalStore;
    globalState.__webAdeLocalStoreLoaded = savedGlobalStore.__webAdeLocalStoreLoaded;
    globalState.__webAdeLocalStorePath = savedGlobalStore.__webAdeLocalStorePath;
    globalState.__webAdeLocalStoreReadOnly = savedGlobalStore.__webAdeLocalStoreReadOnly;
    globalState.__webAdeLocalStoreQueue = savedGlobalStore.__webAdeLocalStoreQueue;

    if (savedDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('uses local fallback cleanly when DATABASE_URL is absent', () => {
    expect(isDatabaseConfigured()).toBe(false);
    expect(getDbOrNull()).toBeNull();
  });

  it('supports chat CRUD, pinning, search, pagination, ownership transfer, and cascading cleanup', async () => {
    const userId = 'guest_user_1';
    const chatA = await createChat({
      id: 'chat-alpha',
      userId,
      title: 'Alpha Design Review',
      modelId: 'openai/gpt-6.2-sol',
      harnessMode: 'ai-sdk',
    });
    const chatB = await createChat({
      id: 'chat-beta',
      userId,
      title: 'Beta Sandbox Prototype',
      pinned: true,
      harnessMode: 'fx',
    });

    // ensureChat is idempotent for existing IDs
    const ensuredExisting = await ensureChat({
      id: 'chat-alpha',
      userId: 'other-user',
      title: 'Should Not Overwrite',
    });
    expect(ensuredExisting.title).toBe('Alpha Design Review');
    expect(ensuredExisting.userId).toBe(userId);

    // Pinned chat appears first
    const listed = await listChats(userId);
    expect(listed.map((c) => c.id)).toEqual([chatB.id, chatA.id]);

    // Search filters case-insensitively
    const searched = await listChats(userId, { search: 'sandbox' });
    expect(searched.map((c) => c.id)).toEqual(['chat-beta']);

    // Update chat metadata
    const updated = await updateChat(chatA.id, {
      title: 'Alpha Renamed',
      visibility: 'public',
      pinned: true,
    });
    expect(updated?.title).toBe('Alpha Renamed');
    expect(updated?.visibility).toBe('public');
    expect(updated?.pinned).toBe(true);

    // Persist a message, vote, artifact, and workspace file on chatA
    await saveMessages(chatA.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello ADE' }] },
    ]);
    await voteMessage(chatA.id, 'm1', true);
    await saveArtifact({
      id: 'art-1',
      chatId: chatA.id,
      userId,
      title: 'Widget',
      kind: 'html',
      content: '<h1>v1</h1>',
    });
    await upsertWorkspaceFile(chatA.id, 'src/demo.ts', 'export const x = 1;');

    // Ownership guard prevents another user from deleting chatA
    expect(await deleteChat(chatA.id, 'wrong-user')).toBe(false);
    expect(await getChatById(chatA.id)).not.toBeNull();

    // Transfer ownership from guest -> signed-in user
    await transferUserOwnership(userId, 'signed_in_user_42');
    expect((await listChats(userId)).length).toBe(0);
    expect((await listChats('signed_in_user_42')).length).toBe(2);

    // Deleting chatA cascades to messages, votes, artifacts, and workspace files
    expect(await deleteChat(chatA.id, 'signed_in_user_42')).toBe(true);
    expect(await getChatById(chatA.id)).toBeNull();
    expect(await getMessagesByChatId(chatA.id)).toEqual([]);
    expect(await getVotesByChatId(chatA.id)).toEqual([]);
    expect(await listArtifactsByChatId(chatA.id)).toEqual([]);
    expect(await getWorkspaceFiles(chatA.id)).toEqual([]);

    // Verify atomic JSON file was flushed to disk
    const rawOnDisk = JSON.parse(await readFile(tempStorePath, 'utf8')) as LocalStoreData;
    expect(rawOnDisk.chats[chatA.id]).toBeUndefined();
    expect(rawOnDisk.chats[chatB.id]?.userId).toBe('signed_in_user_42');
  });

  it('supports message branching, rewind (deleteMessagesAfter), and voting', async () => {
    const chat = await createChat({ id: 'chat-branch', userId: 'u1', title: 'Branching Test' });
    const t0 = new Date('2026-11-19T10:00:00.000Z');
    const t1 = new Date('2026-11-19T10:00:01.000Z');
    const t2 = new Date('2026-11-19T10:00:02.000Z');
    const t3 = new Date('2026-11-19T10:00:03.000Z');

    await saveMessages(chat.id, [
      {
        id: 'u-1',
        parentId: null,
        role: 'user',
        parts: [{ type: 'text', text: 'First prompt' }],
        createdAt: t0,
      },
      {
        id: 'a-1',
        parentId: 'u-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Initial answer' }],
        createdAt: t1,
      },
      {
        id: 'a-1-branch',
        parentId: 'u-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Regenerated branch answer' }],
        createdAt: t2,
      },
      {
        id: 'u-2',
        parentId: 'a-1-branch',
        role: 'user',
        parts: [{ type: 'text', text: 'Follow-up on branch' }],
        createdAt: t3,
      },
    ]);

    const all = await getMessagesByChatId(chat.id);
    expect(all.map((m) => m.id)).toEqual(['u-1', 'a-1', 'a-1-branch', 'u-2']);
    expect(all[2]?.parentId).toBe('u-1');

    // Voting: upvote then flip to downvote
    await voteMessage(chat.id, 'a-1', true);
    await voteMessage(chat.id, 'a-1-branch', true);
    await voteMessage(chat.id, 'a-1-branch', false);

    const votes = await getVotesByChatId(chat.id);
    expect(votes).toEqual(
      expect.arrayContaining([
        { chatId: chat.id, messageId: 'a-1', isUpvoted: true },
        { chatId: chat.id, messageId: 'a-1-branch', isUpvoted: false },
      ]),
    );

    // Rewind exclusive after 'a-1' removes 'a-1-branch' and 'u-2' AND prunes their votes
    const removedExclusive = await deleteMessagesAfter(chat.id, 'a-1');
    expect(removedExclusive).toBe(2);
    expect((await getMessagesByChatId(chat.id)).map((m) => m.id)).toEqual(['u-1', 'a-1']);
    expect(await getVotesByChatId(chat.id)).toEqual([
      { chatId: chat.id, messageId: 'a-1', isUpvoted: true },
    ]);

    // Rewind inclusive on 'a-1' removes 'a-1' too
    const removedInclusive = await deleteMessagesAfter(chat.id, 'a-1', { inclusive: true });
    expect(removedInclusive).toBe(1);
    expect((await getMessagesByChatId(chat.id)).map((m) => m.id)).toEqual(['u-1']);
    expect(await getVotesByChatId(chat.id)).toEqual([]);

    // Non-existent pivot returns 0
    expect(await deleteMessagesAfter(chat.id, 'does-not-exist')).toBe(0);
  });

  it('tracks versioned artifacts (v1 -> v2 -> v3), preserves initial createdAt, and parses genui specs', async () => {
    const chat = await createChat({ id: 'chat-art', userId: 'u1', title: 'Artifacts' });

    const v1 = await saveArtifact({
      id: 'art-dashboard',
      chatId: chat.id,
      userId: 'u1',
      title: 'Telemetry Dashboard',
      kind: 'genui',
      spec: {
        root: 'grid',
        elements: {
          grid: { type: 'MetricGrid', props: { columns: 2 }, children: [] },
        },
      },
    });

    expect(v1.version).toBe(1);
    expect(v1.spec).toEqual({
      root: 'grid',
      elements: {
        grid: { type: 'MetricGrid', props: { columns: 2 }, children: [] },
      },
    });

    const v2 = await saveArtifact({
      id: 'art-dashboard',
      chatId: chat.id,
      userId: 'u1',
      title: 'Telemetry Dashboard v2',
      kind: 'genui',
      spec: {
        root: 'grid',
        elements: {
          grid: { type: 'MetricGrid', props: { columns: 3 }, children: [] },
        },
      },
    });

    expect(v2.version).toBe(2);
    expect(v2.createdAt).toBe(v1.createdAt);
    expect(new Date(v2.updatedAt).getTime()).toBeGreaterThan(new Date(v1.updatedAt).getTime());

    const versions = await getArtifactVersions('art-dashboard');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]?.title).toBe('Telemetry Dashboard');
    expect(versions[1]?.title).toBe('Telemetry Dashboard v2');

    const latest = await getLatestArtifact('art-dashboard');
    expect(latest?.version).toBe(2);

    const listed = await listArtifactsByChatId(chat.id);
    expect(listed.length).toBe(1);
    expect(listed[0]?.version).toBe(2);

    // Ownership check on deleteArtifact
    expect(await deleteArtifact('art-dashboard', 'other-user')).toBe(false);
    expect(await deleteArtifact('art-dashboard', 'u1')).toBe(true);
    expect(await getArtifactVersions('art-dashboard')).toEqual([]);
  });

  it('handles workspace file normalization, upsert, delete, merge sync, and pruneMissing sync', async () => {
    expect(normalizeWorkspacePath('/src//utils/./index.ts')).toBe('src/utils/index.ts');
    expect(() => normalizeWorkspacePath('../etc/passwd')).toThrow();
    expect(() => normalizeWorkspacePath('src/../../secret')).toThrow();
    expect(() => normalizeWorkspacePath('   ')).toThrow();

    const chatId = 'chat-files';
    await createChat({ id: chatId, userId: 'u1', title: 'Workspace Files' });

    const f1 = await upsertWorkspaceFile(chatId, '/README.md', '# Hello');
    expect(f1.path).toBe('README.md');
    expect(f1.size).toBe(7);

    await upsertWorkspaceFile(chatId, 'src/app.ts', 'export const ok = true;');
    await upsertWorkspaceFile(chatId, 'stale.txt', 'old file');

    // Merge sync keeps existing files not in the sync map
    const merged = await syncWorkspaceFiles(chatId, {
      'README.md': '# Updated',
      'src/new.ts': 'export const n = 2;',
    });
    expect(merged.map((f) => f.path)).toEqual([
      'README.md',
      'src/app.ts',
      'src/new.ts',
      'stale.txt',
    ]);

    // Prune sync removes files absent from the sync map
    const pruned = await syncWorkspaceFiles(
      chatId,
      {
        'README.md': '# Final',
        'index.html': '<h1>Live</h1>',
      },
      { pruneMissing: true },
    );
    expect(pruned.map((f) => f.path)).toEqual(['index.html', 'README.md']);

    const map = await getWorkspaceFilesMap(chatId);
    expect(map).toEqual({
      'index.html': '<h1>Live</h1>',
      'README.md': '# Final',
    });

    expect(await deleteWorkspaceFile(chatId, 'README.md')).toBe(true);
    expect(await deleteWorkspaceFile(chatId, 'does-not-exist.md')).toBe(false);
    expect((await getWorkspaceFiles(chatId)).map((f) => f.path)).toEqual(['index.html']);
  });

  it('rejects duplicate chat IDs with ChatAlreadyExistsError and prevents cross-chat saveMessages overwrite', async () => {
    const victim = await createChat({ id: 'chat-victim', userId: 'user-a', title: 'Victim Chat' });
    await expect(
      createChat({ id: 'chat-victim', userId: 'user-b', title: 'Hijack Attempt' }),
    ).rejects.toBeInstanceOf(ChatAlreadyExistsError);

    const attacker = await createChat({
      id: 'chat-attacker',
      userId: 'user-b',
      title: 'Attacker Chat',
    });

    await saveMessages(victim.id, [
      { id: 'shared-msg-id', role: 'user', parts: [{ type: 'text', text: 'Original secret' }] },
    ]);

    const attackerSaved = await saveMessages(attacker.id, [
      {
        id: 'shared-msg-id',
        chatId: victim.id, // Attempt to target victim chat with colliding message ID
        role: 'user',
        parts: [{ type: 'text', text: 'Overwrite attempt' }],
      },
    ]);

    // Victim's message MUST remain untouched
    const victimMessages = await getMessagesByChatId(victim.id);
    expect(victimMessages).toHaveLength(1);
    expect((victimMessages[0]?.parts[0] as { text?: string })?.text).toBe('Original secret');

    // Attacker's message was scoped strictly to attacker.id with a fresh non-colliding ID
    expect(attackerSaved[0]?.chatId).toBe(attacker.id);
    expect(attackerSaved[0]?.id).not.toBe('shared-msg-id');
  });
});
