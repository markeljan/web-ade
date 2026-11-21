import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type {
  ArtifactKind,
  AttachmentItem,
  ChatVisibility,
  HarnessMode,
  MessageMetadata,
} from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Better Auth Core + Anonymous Plugin Tables (better-auth@1.7.26)            */
/* -------------------------------------------------------------------------- */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  isAnonymous: boolean('is_anonymous').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    index('account_provider_user_idx').on(table.providerId, table.userId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/* -------------------------------------------------------------------------- */
/* Minimal ADE Domain Tables                                                  */
/* -------------------------------------------------------------------------- */

export const chat = pgTable(
  'chat',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull().default('New chat'),
    visibility: text('visibility').$type<ChatVisibility>().notNull().default('private'),
    harnessMode: text('harness_mode').$type<HarnessMode>().notNull().default('ai-sdk'),
    modelId: text('model_id').notNull().default('anthropic/claude-haiku-5.5'),
    sandboxName: text('sandbox_name'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chat_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    role: text('role').notNull(),
    parts: jsonb('parts').$type<unknown[]>().notNull().default([]),
    attachments: jsonb('attachments').$type<AttachmentItem[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<MessageMetadata | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('message_chat_created_idx').on(table.chatId, table.createdAt)],
);

export const vote = pgTable(
  'vote',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    isUpvoted: boolean('is_upvoted').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.messageId] })],
);

export const artifact = pgTable(
  'artifact',
  {
    id: text('id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').$type<ArtifactKind>().notNull().default('code'),
    language: text('language'),
    content: text('content').notNull().default(''),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    index('artifact_chat_created_idx').on(table.chatId, table.createdAt),
  ],
);

export const workspaceFile = pgTable(
  'workspace_file',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.path] }),
    index('workspace_file_chat_idx').on(table.chatId),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  chat,
  message,
  vote,
  artifact,
  workspaceFile,
};

export type UserRow = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
export type ChatRow = typeof chat.$inferSelect;
export type NewChatRow = typeof chat.$inferInsert;
export type MessageRow = typeof message.$inferSelect;
export type NewMessageRow = typeof message.$inferInsert;
export type VoteRow = typeof vote.$inferSelect;
export type ArtifactRow = typeof artifact.$inferSelect;
export type WorkspaceFileRow = typeof workspaceFile.$inferSelect;
