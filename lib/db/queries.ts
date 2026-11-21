import { metric } from '@vercel/functions';
import { and, asc, desc, eq, gt, gte, ilike, inArray, notInArray, sql } from 'drizzle-orm';
import { getDbOrNull, isDatabaseConfigured } from '@/lib/db/index';
import {
  type LocalArtifactEntry,
  type LocalChatEntry,
  type LocalMessageEntry,
  mutateLocalStore,
  readLocalStore,
} from '@/lib/db/local-store';
import {
  type ArtifactRow,
  artifact,
  type ChatRow,
  chat,
  type MessageRow,
  message,
  type VoteRow,
  vote,
  type WorkspaceFileRow,
  workspaceFile,
} from '@/lib/db/schema';
import type {
  ArtifactKind,
  ArtifactRecord,
  AttachmentItem,
  ChatSummary,
  ChatVisibility,
  HarnessMode,
  MessageMetadata,
} from '@/lib/types';
import { generateId, truncateText } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Public Types                                                               */
/* -------------------------------------------------------------------------- */

export interface ChatRecord extends ChatSummary {
  userId: string;
  pinned: boolean;
  sandboxName: string | null;
}

/** Thrown by `createChat` when an explicit chat ID already exists. */
export class ChatAlreadyExistsError extends Error {
  readonly chatId: string;

  constructor(chatId: string) {
    super(`Chat "${chatId}" already exists`);
    this.name = 'ChatAlreadyExistsError';
    this.chatId = chatId;
  }
}

export interface ListChatsOptions {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface CreateChatInput {
  id?: string;
  userId: string;
  title?: string;
  visibility?: ChatVisibility;
  harnessMode?: HarnessMode;
  modelId?: string;
  sandboxName?: string | null;
  pinned?: boolean;
}

export interface UpdateChatInput {
  title?: string;
  visibility?: ChatVisibility;
  harnessMode?: HarnessMode;
  modelId?: string;
  sandboxName?: string | null;
  pinned?: boolean;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface StoredMessageRecord {
  id: string;
  chatId: string;
  parentId: string | null;
  role: MessageRole;
  parts: unknown[];
  attachments: AttachmentItem[];
  metadata: MessageMetadata | null;
  createdAt: string;
}

export interface SaveMessageInput {
  id?: string;
  chatId?: string;
  parentId?: string | null;
  role: MessageRole;
  parts: unknown[];
  attachments?: AttachmentItem[];
  metadata?: MessageMetadata | null;
  createdAt?: Date | string;
}

export interface VoteRecord {
  chatId: string;
  messageId: string;
  isUpvoted: boolean;
}

export interface SaveArtifactInput {
  id?: string;
  chatId: string;
  userId: string;
  title: string;
  kind: ArtifactKind;
  language?: string | null;
  content?: string;
  spec?: Record<string, unknown> | null;
}

export interface WorkspaceFileRecord {
  chatId: string;
  path: string;
  content: string;
  updatedAt: string;
  size: number;
}

/* -------------------------------------------------------------------------- */
/* Internal Helpers                                                           */
/* -------------------------------------------------------------------------- */

const DEFAULT_MODEL_ID = 'openai/gpt-6-luna';
const DEFAULT_HARNESS_MODE: HarnessMode = 'ai-sdk';

function storageBackendTag(): 'postgres' | 'local' {
  return isDatabaseConfigured() ? 'postgres' : 'local';
}

function emitDbMetric(name: string, tags: Record<string, string>): void {
  try {
    metric(name, 1, tags);
  } catch {
    // Metrics are best-effort and must never fail DB operations.
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDate(value?: Date | string): Date {
  if (!value) {
    return new Date();
  }
  return value instanceof Date ? value : new Date(value);
}

function normalizeRole(role: string): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role;
  }
  return 'assistant';
}

function extractMessagePreview(parts: unknown[]): string | undefined {
  for (const part of parts) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type?: unknown }).type === 'text' &&
      'text' in part &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text.trim();
      if (text.length > 0) {
        return truncateText(text, 120);
      }
    }
  }
  return undefined;
}

function parseGenUiSpec(
  kind: ArtifactKind,
  content: string,
): Record<string, unknown> | null | undefined {
  if (kind !== 'genui') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Content may be streaming or partial JSON; return null safely.
  }
  return null;
}

function mapChatRow(
  row: ChatRow | LocalChatEntry,
  extra?: { messageCount?: number; lastMessagePreview?: string },
): ChatRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    visibility: row.visibility,
    harnessMode: row.harnessMode,
    modelId: row.modelId,
    sandboxName: row.sandboxName ?? null,
    pinned: Boolean(row.pinned),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    messageCount: extra?.messageCount,
    lastMessagePreview: extra?.lastMessagePreview,
  };
}

function mapMessageRow(row: MessageRow | LocalMessageEntry): StoredMessageRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    parentId: row.parentId ?? null,
    role: normalizeRole(row.role),
    parts: Array.isArray(row.parts) ? row.parts : [],
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    metadata: row.metadata ?? null,
    createdAt: toIsoString(row.createdAt),
  };
}

function mapVoteRow(row: VoteRow): VoteRecord {
  return {
    chatId: row.chatId,
    messageId: row.messageId,
    isUpvoted: row.isUpvoted,
  };
}

function mapArtifactVersion(
  row: ArtifactRow | LocalArtifactEntry,
  version: number,
  initialCreatedAt?: Date | string,
): ArtifactRecord {
  const rowIso = toIsoString(row.createdAt);
  const spec = parseGenUiSpec(row.kind, row.content);
  return {
    id: row.id,
    chatId: row.chatId,
    title: row.title,
    kind: row.kind,
    content: row.content,
    language: row.language ?? undefined,
    version,
    ...(spec !== undefined ? { spec } : {}),
    createdAt: initialCreatedAt ? toIsoString(initialCreatedAt) : rowIso,
    updatedAt: rowIso,
  };
}

function mapWorkspaceFileRow(
  row: WorkspaceFileRow | { chatId: string; path: string; content: string; updatedAt: string },
): WorkspaceFileRecord {
  return {
    chatId: row.chatId,
    path: row.path,
    content: row.content,
    updatedAt: toIsoString(row.updatedAt),
    size: Buffer.byteLength(row.content, 'utf8'),
  };
}

/** Normalizes and validates a relative workspace file path, rejecting traversal segments. */
export function normalizeWorkspacePath(rawPath: string): string {
  const replaced = rawPath.replaceAll('\\', '/').trim();
  const segments = replaced
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.length === 0) {
    throw new Error('Workspace file path cannot be empty.');
  }

  for (const segment of segments) {
    if (segment === '..' || segment.includes('\0')) {
      throw new Error(`Invalid workspace file path: "${rawPath}"`);
    }
  }

  return segments.join('/');
}

/* -------------------------------------------------------------------------- */
/* Chat Queries                                                               */
/* -------------------------------------------------------------------------- */

export async function listChats(
  userId: string,
  options: ListChatsOptions = {},
): Promise<ChatRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = options.search?.trim();

  const db = getDbOrNull();
  if (db) {
    const conditions = search
      ? and(eq(chat.userId, userId), ilike(chat.title, `%${search}%`))
      : eq(chat.userId, userId);

    const rows = await db
      .select()
      .from(chat)
      .where(conditions)
      .orderBy(desc(chat.pinned), desc(chat.updatedAt))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) {
      return [];
    }

    const chatIds = rows.map((row) => row.id);
    const [countRows, previewRows] = await Promise.all([
      db
        .select({
          chatId: message.chatId,
          messageCount: sql<number>`count(*)::int`,
        })
        .from(message)
        .where(inArray(message.chatId, chatIds))
        .groupBy(message.chatId),
      db
        .selectDistinctOn([message.chatId], {
          chatId: message.chatId,
          preview: sql<string | null>`left((
            select elem->>'text'
            from jsonb_array_elements(${message.parts}) as elem
            where elem->>'type' = 'text'
              and length(btrim(coalesce(elem->>'text', ''))) > 0
            limit 1
          ), 160)`,
        })
        .from(message)
        .where(
          and(
            inArray(message.chatId, chatIds),
            sql`jsonb_typeof(${message.parts}) = 'array'`,
            sql`exists (
              select 1
              from jsonb_array_elements(${message.parts}) as elem
              where elem->>'type' = 'text'
                and length(btrim(coalesce(elem->>'text', ''))) > 0
            )`,
          ),
        )
        .orderBy(asc(message.chatId), desc(message.createdAt)),
    ]);

    const countByChat = new Map<string, number>();
    for (const row of countRows) {
      countByChat.set(row.chatId, Number(row.messageCount) || 0);
    }

    const previewByChat = new Map<string, string>();
    for (const row of previewRows) {
      const text = row.preview?.trim();
      if (text) {
        previewByChat.set(row.chatId, truncateText(text, 120));
      }
    }

    return rows.map((row) =>
      mapChatRow(row, {
        messageCount: countByChat.get(row.id) ?? 0,
        lastMessagePreview: previewByChat.get(row.id),
      }),
    );
  }

  const store = await readLocalStore();
  const normalizedSearch = search?.toLowerCase();
  const filtered = Object.values(store.chats)
    .filter((entry) => entry.userId === userId)
    .filter((entry) =>
      normalizedSearch ? entry.title.toLowerCase().includes(normalizedSearch) : true,
    )
    .sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(offset, offset + limit);

  return filtered.map((entry) => {
    const msgs = store.messages[entry.id] ?? [];
    let lastPreview: string | undefined;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const preview = extractMessagePreview(msgs[i]?.parts ?? []);
      if (preview) {
        lastPreview = preview;
        break;
      }
    }
    return mapChatRow(entry, {
      messageCount: msgs.length,
      lastMessagePreview: lastPreview,
    });
  });
}

export async function getChatById(chatId: string): Promise<ChatRecord | null> {
  const db = getDbOrNull();
  if (db) {
    const [row] = await db.select().from(chat).where(eq(chat.id, chatId)).limit(1);
    return row ? mapChatRow(row) : null;
  }

  const store = await readLocalStore();
  const entry = store.chats[chatId];
  return entry ? mapChatRow(entry) : null;
}

export async function createChat(input: CreateChatInput): Promise<ChatRecord> {
  const now = new Date();
  const id = input.id?.trim() || generateId('chat');
  const title = input.title?.trim() || 'New chat';
  const visibility: ChatVisibility = input.visibility ?? 'private';
  const harnessMode: HarnessMode = input.harnessMode ?? DEFAULT_HARNESS_MODE;
  const modelId = input.modelId?.trim() || DEFAULT_MODEL_ID;
  const sandboxName = input.sandboxName ?? null;
  const pinned = Boolean(input.pinned ?? false);

  const db = getDbOrNull();
  if (db) {
    const [inserted] = await db
      .insert(chat)
      .values({
        id,
        userId: input.userId,
        title,
        visibility,
        harnessMode,
        modelId,
        sandboxName,
        pinned,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: chat.id })
      .returning();

    if (!inserted) {
      throw new ChatAlreadyExistsError(id);
    }

    emitDbMetric('ade.db.chats', { action: 'create', backend: 'postgres' });
    return mapChatRow(inserted, { messageCount: 0 });
  }

  const entry: LocalChatEntry = {
    id,
    userId: input.userId,
    title,
    visibility,
    harnessMode,
    modelId,
    sandboxName,
    pinned,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await mutateLocalStore((store) => {
    if (store.chats[id]) {
      throw new ChatAlreadyExistsError(id);
    }
    store.chats[id] = entry;
  });

  emitDbMetric('ade.db.chats', { action: 'create', backend: 'local' });
  return mapChatRow(entry, { messageCount: 0 });
}

export async function ensureChat(input: CreateChatInput & { id: string }): Promise<ChatRecord> {
  const existing = await getChatById(input.id);
  if (existing) {
    return existing;
  }

  const now = new Date();
  const title = input.title?.trim() || 'New chat';
  const visibility: ChatVisibility = input.visibility ?? 'private';
  const harnessMode: HarnessMode = input.harnessMode ?? DEFAULT_HARNESS_MODE;
  const modelId = input.modelId?.trim() || DEFAULT_MODEL_ID;
  const sandboxName = input.sandboxName ?? null;
  const pinned = Boolean(input.pinned ?? false);

  const db = getDbOrNull();
  if (db) {
    const [inserted] = await db
      .insert(chat)
      .values({
        id: input.id,
        userId: input.userId,
        title,
        visibility,
        harnessMode,
        modelId,
        sandboxName,
        pinned,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: chat.id })
      .returning();

    if (inserted) {
      emitDbMetric('ade.db.chats', { action: 'create', backend: 'postgres' });
      return mapChatRow(inserted, { messageCount: 0 });
    }

    const fetched = await getChatById(input.id);
    if (fetched) {
      return fetched;
    }
    throw new Error(`Failed to ensure chat "${input.id}"`);
  }

  let created = false;
  const entry = await mutateLocalStore((store) => {
    const current = store.chats[input.id];
    if (current) {
      return current;
    }
    created = true;
    const next: LocalChatEntry = {
      id: input.id,
      userId: input.userId,
      title,
      visibility,
      harnessMode,
      modelId,
      sandboxName,
      pinned,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    store.chats[input.id] = next;
    return next;
  });

  if (created) {
    emitDbMetric('ade.db.chats', { action: 'create', backend: 'local' });
  }
  return mapChatRow(entry);
}

export async function updateChat(
  chatId: string,
  patch: UpdateChatInput,
): Promise<ChatRecord | null> {
  const now = new Date();
  const db = getDbOrNull();

  if (db) {
    const updates: Partial<typeof chat.$inferInsert> = {
      updatedAt: now,
    };
    if (patch.title !== undefined) updates.title = patch.title.trim() || 'New chat';
    if (patch.visibility !== undefined) updates.visibility = patch.visibility;
    if (patch.harnessMode !== undefined) updates.harnessMode = patch.harnessMode;
    if (patch.modelId !== undefined) updates.modelId = patch.modelId;
    if (patch.sandboxName !== undefined) updates.sandboxName = patch.sandboxName;
    if (patch.pinned !== undefined) updates.pinned = patch.pinned;

    const [updated] = await db.update(chat).set(updates).where(eq(chat.id, chatId)).returning();

    if (!updated) {
      return null;
    }

    emitDbMetric('ade.db.chats', { action: 'update', backend: 'postgres' });
    return mapChatRow(updated);
  }

  const updated = await mutateLocalStore((store) => {
    const existing = store.chats[chatId];
    if (!existing) {
      return null;
    }
    const next: LocalChatEntry = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() || 'New chat' } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.harnessMode !== undefined ? { harnessMode: patch.harnessMode } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
      ...(patch.sandboxName !== undefined ? { sandboxName: patch.sandboxName } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updatedAt: now.toISOString(),
    };
    store.chats[chatId] = next;
    return next;
  });

  if (!updated) {
    return null;
  }

  emitDbMetric('ade.db.chats', { action: 'update', backend: 'local' });
  return mapChatRow(updated);
}

export async function deleteChat(chatId: string, userId?: string): Promise<boolean> {
  const db = getDbOrNull();
  if (db) {
    const condition = userId
      ? and(eq(chat.id, chatId), eq(chat.userId, userId))
      : eq(chat.id, chatId);

    const deleted = await db.delete(chat).where(condition).returning({ id: chat.id });
    if (deleted.length > 0) {
      emitDbMetric('ade.db.chats', { action: 'delete', backend: 'postgres' });
      return true;
    }
    return false;
  }

  const removed = await mutateLocalStore((store) => {
    const existing = store.chats[chatId];
    if (!existing) {
      return false;
    }
    if (userId && existing.userId !== userId) {
      return false;
    }
    delete store.chats[chatId];
    delete store.messages[chatId];
    delete store.votes[chatId];
    delete store.artifacts[chatId];
    delete store.workspaceFiles[chatId];
    return true;
  });

  if (removed) {
    emitDbMetric('ade.db.chats', { action: 'delete', backend: 'local' });
  }
  return removed;
}

/** Transfers all chats and artifacts from an anonymous guest user to a signed-in user. */
export async function transferUserOwnership(fromUserId: string, toUserId: string): Promise<void> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) {
    return;
  }

  const db = getDbOrNull();
  if (db) {
    await db.update(chat).set({ userId: toUserId }).where(eq(chat.userId, fromUserId));
    await db.update(artifact).set({ userId: toUserId }).where(eq(artifact.userId, fromUserId));
    return;
  }

  await mutateLocalStore((store) => {
    for (const entry of Object.values(store.chats)) {
      if (entry.userId === fromUserId) {
        entry.userId = toUserId;
      }
    }
    for (const list of Object.values(store.artifacts)) {
      for (const item of list) {
        if (item.userId === fromUserId) {
          item.userId = toUserId;
        }
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Message Queries                                                            */
/* -------------------------------------------------------------------------- */

export async function getMessagesByChatId(chatId: string): Promise<StoredMessageRecord[]> {
  const db = getDbOrNull();
  if (db) {
    const rows = await db
      .select()
      .from(message)
      .where(eq(message.chatId, chatId))
      .orderBy(asc(message.createdAt));

    return rows.map(mapMessageRow);
  }

  const store = await readLocalStore();
  const entries = store.messages[chatId] ?? [];
  return [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(mapMessageRow);
}

export async function saveMessages(
  chatId: string,
  messagesToSave: SaveMessageInput[],
): Promise<StoredMessageRecord[]> {
  if (messagesToSave.length === 0) {
    return [];
  }

  const now = new Date();
  const baseMs = now.getTime();
  const normalized = messagesToSave.map((item, idx) => {
    const createdDate = item.createdAt ? toDate(item.createdAt) : new Date(baseMs + idx);
    return {
      id: item.id?.trim() || generateId('msg'),
      chatId,
      parentId: item.parentId ?? null,
      role: normalizeRole(item.role),
      parts: Array.isArray(item.parts) ? item.parts : [],
      attachments: Array.isArray(item.attachments) ? item.attachments : [],
      metadata: item.metadata ?? null,
      createdAt: createdDate,
    };
  });

  const db = getDbOrNull();
  if (db) {
    const saved: StoredMessageRecord[] = [];
    for (const item of normalized) {
      const [row] = await db
        .insert(message)
        .values({
          id: item.id,
          chatId,
          parentId: item.parentId,
          role: item.role,
          parts: item.parts,
          attachments: item.attachments,
          metadata: item.metadata,
          createdAt: item.createdAt,
        })
        .onConflictDoUpdate({
          target: message.id,
          set: {
            parentId: item.parentId,
            role: item.role,
            parts: item.parts,
            attachments: item.attachments,
            metadata: item.metadata,
          },
          setWhere: eq(message.chatId, chatId),
        })
        .returning();

      if (row) {
        saved.push(mapMessageRow(row));
      } else {
        // Cross-tenant message ID collision: never overwrite another chat's message.
        // Persist cleanly under a freshly minted ID scoped to this chatId.
        const [mintedRow] = await db
          .insert(message)
          .values({
            id: generateId('msg'),
            chatId,
            parentId: item.parentId,
            role: item.role,
            parts: item.parts,
            attachments: item.attachments,
            metadata: item.metadata,
            createdAt: item.createdAt,
          })
          .returning();

        if (mintedRow) {
          saved.push(mapMessageRow(mintedRow));
        }
      }
    }

    await db.update(chat).set({ updatedAt: now }).where(eq(chat.id, chatId));
    emitDbMetric('ade.db.messages', { action: 'save', backend: 'postgres' });
    return saved;
  }

  const saved = await mutateLocalStore((store) => {
    const foreignIds = new Set<string>();
    for (const [otherChatId, entries] of Object.entries(store.messages)) {
      if (otherChatId === chatId) continue;
      for (const entry of entries) {
        foreignIds.add(entry.id);
      }
    }

    const current = store.messages[chatId] ?? [];
    const byId = new Map(current.map((entry) => [entry.id, entry]));

    const results: StoredMessageRecord[] = [];
    for (const item of normalized) {
      const safeId = foreignIds.has(item.id) ? generateId('msg') : item.id;
      const existing = byId.get(safeId);
      const entry: LocalMessageEntry = {
        id: safeId,
        chatId,
        parentId: item.parentId,
        role: item.role,
        parts: item.parts,
        attachments: item.attachments,
        metadata: item.metadata,
        createdAt: existing ? existing.createdAt : item.createdAt.toISOString(),
      };
      byId.set(safeId, entry);
      results.push(mapMessageRow(entry));
    }

    store.messages[chatId] = Array.from(byId.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    if (store.chats[chatId]) {
      store.chats[chatId].updatedAt = now.toISOString();
    }

    return results;
  });

  emitDbMetric('ade.db.messages', { action: 'save', backend: 'local' });
  return saved;
}

export async function deleteMessagesAfter(
  chatId: string,
  messageId: string,
  options: { inclusive?: boolean } = {},
): Promise<number> {
  const inclusive = Boolean(options.inclusive);
  const db = getDbOrNull();

  if (db) {
    const [pivot] = await db
      .select({ createdAt: message.createdAt })
      .from(message)
      .where(and(eq(message.chatId, chatId), eq(message.id, messageId)))
      .limit(1);

    if (!pivot) {
      return 0;
    }

    const comparator = inclusive
      ? gte(message.createdAt, pivot.createdAt)
      : gt(message.createdAt, pivot.createdAt);

    const deleted = await db
      .delete(message)
      .where(and(eq(message.chatId, chatId), comparator))
      .returning({ id: message.id });

    if (deleted.length > 0) {
      await db.update(chat).set({ updatedAt: new Date() }).where(eq(chat.id, chatId));
      emitDbMetric('ade.db.messages', { action: 'rewind', backend: 'postgres' });
    }

    return deleted.length;
  }

  const deletedCount = await mutateLocalStore((store) => {
    const entries = store.messages[chatId] ?? [];
    const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const pivotIdx = sorted.findIndex((entry) => entry.id === messageId);
    if (pivotIdx === -1) {
      return 0;
    }

    const keepUntil = inclusive ? pivotIdx : pivotIdx + 1;
    const kept = sorted.slice(0, keepUntil);
    const removed = sorted.slice(keepUntil);
    store.messages[chatId] = kept;

    const chatVotes = store.votes[chatId];
    if (chatVotes) {
      for (const removedMsg of removed) {
        delete chatVotes[removedMsg.id];
      }
    }

    if (store.chats[chatId] && removed.length > 0) {
      store.chats[chatId].updatedAt = new Date().toISOString();
    }

    return removed.length;
  });

  if (deletedCount > 0) {
    emitDbMetric('ade.db.messages', { action: 'rewind', backend: 'local' });
  }
  return deletedCount;
}

/* -------------------------------------------------------------------------- */
/* Vote Queries                                                               */
/* -------------------------------------------------------------------------- */

export async function voteMessage(
  chatId: string,
  messageId: string,
  isUpvoted: boolean,
): Promise<VoteRecord> {
  const db = getDbOrNull();
  if (db) {
    const [row] = await db
      .insert(vote)
      .values({ chatId, messageId, isUpvoted })
      .onConflictDoUpdate({
        target: [vote.chatId, vote.messageId],
        set: { isUpvoted },
      })
      .returning();

    emitDbMetric('ade.db.votes', {
      direction: isUpvoted ? 'up' : 'down',
      backend: 'postgres',
    });
    return mapVoteRow(row);
  }

  await mutateLocalStore((store) => {
    if (!store.votes[chatId]) {
      store.votes[chatId] = {};
    }
    store.votes[chatId][messageId] = isUpvoted;
  });

  emitDbMetric('ade.db.votes', {
    direction: isUpvoted ? 'up' : 'down',
    backend: 'local',
  });
  return { chatId, messageId, isUpvoted };
}

export async function getVotesByChatId(chatId: string): Promise<VoteRecord[]> {
  const db = getDbOrNull();
  if (db) {
    const rows = await db.select().from(vote).where(eq(vote.chatId, chatId));
    return rows.map(mapVoteRow);
  }

  const store = await readLocalStore();
  const chatVotes = store.votes[chatId] ?? {};
  return Object.entries(chatVotes).map(([messageId, isUpvoted]) => ({
    chatId,
    messageId,
    isUpvoted,
  }));
}

/* -------------------------------------------------------------------------- */
/* Artifact Queries (Versioned Composite PK: id + createdAt)                  */
/* -------------------------------------------------------------------------- */

export async function listArtifactsByChatId(chatId: string): Promise<ArtifactRecord[]> {
  const db = getDbOrNull();
  let rows: Array<ArtifactRow | LocalArtifactEntry>;

  if (db) {
    rows = await db
      .select()
      .from(artifact)
      .where(eq(artifact.chatId, chatId))
      .orderBy(asc(artifact.createdAt));
  } else {
    const store = await readLocalStore();
    rows = [...(store.artifacts[chatId] ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  const grouped = new Map<
    string,
    { firstCreatedAt: Date | string; latest: ArtifactRow | LocalArtifactEntry; count: number }
  >();

  for (const row of rows) {
    const current = grouped.get(row.id);
    if (!current) {
      grouped.set(row.id, { firstCreatedAt: row.createdAt, latest: row, count: 1 });
    } else {
      current.latest = row;
      current.count += 1;
    }
  }

  return Array.from(grouped.values())
    .map(({ firstCreatedAt, latest, count }) => mapArtifactVersion(latest, count, firstCreatedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getArtifactVersions(artifactId: string): Promise<ArtifactRecord[]> {
  const db = getDbOrNull();
  let rows: Array<ArtifactRow | LocalArtifactEntry>;

  if (db) {
    rows = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .orderBy(asc(artifact.createdAt));
  } else {
    const store = await readLocalStore();
    const collected: LocalArtifactEntry[] = [];
    for (const chatArtifacts of Object.values(store.artifacts)) {
      for (const item of chatArtifacts) {
        if (item.id === artifactId) {
          collected.push(item);
        }
      }
    }
    rows = collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const initialCreatedAt = rows[0]?.createdAt;
  return rows.map((row, idx) => mapArtifactVersion(row, idx + 1, initialCreatedAt));
}

export async function getLatestArtifact(artifactId: string): Promise<ArtifactRecord | null> {
  const versions = await getArtifactVersions(artifactId);
  return versions.at(-1) ?? null;
}

export async function saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
  const id = input.id?.trim() || generateId('art');
  const title = input.title.trim() || 'Untitled Artifact';
  const content =
    input.content !== undefined
      ? input.content
      : input.spec
        ? JSON.stringify(input.spec, null, 2)
        : '';
  const language = input.language ?? null;

  const existingVersions = await getArtifactVersions(id);
  const latestExistingMs = existingVersions.at(-1)
    ? new Date(existingVersions.at(-1)!.updatedAt).getTime()
    : 0;
  const nowMs = Math.max(Date.now(), latestExistingMs + 1);
  const createdAt = new Date(nowMs);
  const nextVersion = existingVersions.length + 1;
  const firstCreatedAt = existingVersions[0]?.createdAt ?? createdAt.toISOString();

  const db = getDbOrNull();
  if (db) {
    const [inserted] = await db
      .insert(artifact)
      .values({
        id,
        createdAt,
        chatId: input.chatId,
        userId: input.userId,
        title,
        kind: input.kind,
        language,
        content,
      })
      .returning();

    await db.update(chat).set({ updatedAt: createdAt }).where(eq(chat.id, input.chatId));
    emitDbMetric('ade.db.artifacts', {
      action: 'save',
      kind: input.kind,
      backend: 'postgres',
    });

    return mapArtifactVersion(inserted, nextVersion, firstCreatedAt);
  }

  const entry: LocalArtifactEntry = {
    id,
    createdAt: createdAt.toISOString(),
    chatId: input.chatId,
    userId: input.userId,
    title,
    kind: input.kind,
    language,
    content,
  };

  await mutateLocalStore((store) => {
    if (!store.artifacts[input.chatId]) {
      store.artifacts[input.chatId] = [];
    }
    store.artifacts[input.chatId].push(entry);
    if (store.chats[input.chatId]) {
      store.chats[input.chatId].updatedAt = entry.createdAt;
    }
  });

  emitDbMetric('ade.db.artifacts', {
    action: 'save',
    kind: input.kind,
    backend: 'local',
  });

  return mapArtifactVersion(entry, nextVersion, firstCreatedAt);
}

export async function deleteArtifact(artifactId: string, userId?: string): Promise<boolean> {
  const db = getDbOrNull();
  if (db) {
    const condition = userId
      ? and(eq(artifact.id, artifactId), eq(artifact.userId, userId))
      : eq(artifact.id, artifactId);

    const deleted = await db.delete(artifact).where(condition).returning({ id: artifact.id });
    if (deleted.length > 0) {
      emitDbMetric('ade.db.artifacts', { action: 'delete', backend: 'postgres' });
      return true;
    }
    return false;
  }

  const removed = await mutateLocalStore((store) => {
    let anyRemoved = false;
    for (const [chatId, list] of Object.entries(store.artifacts)) {
      const next = list.filter((item) => {
        if (item.id !== artifactId) {
          return true;
        }
        if (userId && item.userId !== userId) {
          return true;
        }
        anyRemoved = true;
        return false;
      });
      store.artifacts[chatId] = next;
    }
    return anyRemoved;
  });

  if (removed) {
    emitDbMetric('ade.db.artifacts', { action: 'delete', backend: 'local' });
  }
  return removed;
}

/* -------------------------------------------------------------------------- */
/* Workspace File Queries (just-bash / Sandbox persistence per chat)          */
/* -------------------------------------------------------------------------- */

export async function getWorkspaceFiles(chatId: string): Promise<WorkspaceFileRecord[]> {
  const db = getDbOrNull();
  if (db) {
    const rows = await db
      .select()
      .from(workspaceFile)
      .where(eq(workspaceFile.chatId, chatId))
      .orderBy(asc(workspaceFile.path));

    return rows.map(mapWorkspaceFileRow);
  }

  const store = await readLocalStore();
  const files = Object.values(store.workspaceFiles[chatId] ?? {});
  return files.sort((a, b) => a.path.localeCompare(b.path)).map(mapWorkspaceFileRow);
}

export async function getWorkspaceFilesMap(chatId: string): Promise<Record<string, string>> {
  const files = await getWorkspaceFiles(chatId);
  const map: Record<string, string> = {};
  for (const file of files) {
    map[file.path] = file.content;
  }
  return map;
}

export async function upsertWorkspaceFile(
  chatId: string,
  rawPath: string,
  content: string,
): Promise<WorkspaceFileRecord> {
  const filePath = normalizeWorkspacePath(rawPath);
  const now = new Date();
  const db = getDbOrNull();

  if (db) {
    const [row] = await db
      .insert(workspaceFile)
      .values({
        chatId,
        path: filePath,
        content,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceFile.chatId, workspaceFile.path],
        set: {
          content,
          updatedAt: now,
        },
      })
      .returning();

    return mapWorkspaceFileRow(row);
  }

  const entry = {
    chatId,
    path: filePath,
    content,
    updatedAt: now.toISOString(),
  };

  await mutateLocalStore((store) => {
    if (!store.workspaceFiles[chatId]) {
      store.workspaceFiles[chatId] = {};
    }
    store.workspaceFiles[chatId][filePath] = entry;
  });

  return mapWorkspaceFileRow(entry);
}

export async function deleteWorkspaceFile(chatId: string, rawPath: string): Promise<boolean> {
  const filePath = normalizeWorkspacePath(rawPath);
  const db = getDbOrNull();

  if (db) {
    const deleted = await db
      .delete(workspaceFile)
      .where(and(eq(workspaceFile.chatId, chatId), eq(workspaceFile.path, filePath)))
      .returning({ path: workspaceFile.path });
    return deleted.length > 0;
  }

  return mutateLocalStore((store) => {
    const chatFiles = store.workspaceFiles[chatId];
    if (!chatFiles || !(filePath in chatFiles)) {
      return false;
    }
    delete chatFiles[filePath];
    return true;
  });
}

export async function syncWorkspaceFiles(
  chatId: string,
  files: Record<string, string>,
  options: { pruneMissing?: boolean } = {},
): Promise<WorkspaceFileRecord[]> {
  const now = new Date();
  const normalizedEntries: Array<[string, string]> = [];

  for (const [rawPath, content] of Object.entries(files)) {
    try {
      normalizedEntries.push([normalizeWorkspacePath(rawPath), content]);
    } catch {
      // Skip invalid paths defensively during bulk sync.
    }
  }

  const db = getDbOrNull();
  if (db) {
    for (const [filePath, content] of normalizedEntries) {
      await db
        .insert(workspaceFile)
        .values({
          chatId,
          path: filePath,
          content,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [workspaceFile.chatId, workspaceFile.path],
          set: {
            content,
            updatedAt: now,
          },
        });
    }

    if (options.pruneMissing) {
      const keepPaths = normalizedEntries.map(([filePath]) => filePath);
      if (keepPaths.length === 0) {
        await db.delete(workspaceFile).where(eq(workspaceFile.chatId, chatId));
      } else {
        await db
          .delete(workspaceFile)
          .where(and(eq(workspaceFile.chatId, chatId), notInArray(workspaceFile.path, keepPaths)));
      }
    }

    emitDbMetric('ade.db.workspace_sync', { backend: storageBackendTag() });
    return getWorkspaceFiles(chatId);
  }

  await mutateLocalStore((store) => {
    const nextMap: Record<
      string,
      { chatId: string; path: string; content: string; updatedAt: string }
    > = options.pruneMissing ? {} : { ...(store.workspaceFiles[chatId] ?? {}) };

    for (const [filePath, content] of normalizedEntries) {
      nextMap[filePath] = {
        chatId,
        path: filePath,
        content,
        updatedAt: now.toISOString(),
      };
    }

    store.workspaceFiles[chatId] = nextMap;
  });

  emitDbMetric('ade.db.workspace_sync', { backend: storageBackendTag() });
  return getWorkspaceFiles(chatId);
}
