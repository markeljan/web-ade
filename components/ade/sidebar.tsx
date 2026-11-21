'use client';

import {
  Check,
  Copy,
  Globe,
  Lock,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { signInWithVercel, signOut } from '@/lib/auth/auth-client';
import type { ChatSummary } from '@/lib/types';
import { cn, formatRelativeTime } from '@/lib/utils';

export interface SidebarChatItem extends ChatSummary {
  pinned?: boolean;
}

export interface SidebarProps {
  open: boolean;
  chats: SidebarChatItem[];
  activeChatId?: string;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onRenameChat: (chatId: string, title: string) => Promise<void> | void;
  onDeleteChat: (chatId: string) => Promise<void> | void;
  onTogglePinChat: (chatId: string, pinned: boolean) => Promise<void> | void;
  onToggleVisibility: (chatId: string, visibility: 'private' | 'public') => Promise<void> | void;
  onCloseSidebar: () => void;
  onOpenSettings: () => void;
  onCopyMcpUrl: () => void;
  sessionUser?: {
    userId: string;
    name?: string;
    email?: string;
    image?: string;
    isGuest: boolean;
  } | null;
  vercelOAuthConfigured?: boolean;
}

function isSameCalendarDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function Sidebar({
  open,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onRenameChat,
  onDeleteChat,
  onTogglePinChat,
  onToggleVisibility,
  onCloseSidebar,
  onOpenSettings,
  onCopyMcpUrl,
  sessionUser,
  vercelOAuthConfigured = false,
}: SidebarProps) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? chats.filter(
          (c) =>
            c.title.toLowerCase().includes(q) || c.lastMessagePreview?.toLowerCase().includes(q),
        )
      : chats;

    const now = new Date();
    const pinned: SidebarChatItem[] = [];
    const today: SidebarChatItem[] = [];
    const previous: SidebarChatItem[] = [];

    for (const chat of filtered) {
      if (chat.pinned) {
        pinned.push(chat);
      } else if (isSameCalendarDay(chat.updatedAt, now)) {
        today.push(chat);
      } else {
        previous.push(chat);
      }
    }

    return { pinned, today, previous, total: filtered.length };
  }, [chats, search]);

  if (!open) return null;

  const commitRename = async (chatId: string) => {
    const trimmed = editingTitle.trim();
    setEditingId(null);
    if (!trimmed) return;
    await onRenameChat(chatId, trimmed);
  };

  const renderGroup = (label: string, items: SidebarChatItem[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-0.5">
        <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
          {label}
        </div>
        {items.map((chat) => {
          const isActive = chat.id === activeChatId;
          const isEditing = editingId === chat.id;

          return (
            <div
              key={chat.id}
              className={cn(
                'group relative flex items-center gap-1.5 rounded-[var(--radius-element)] px-2.5 py-2 text-xs transition-colors',
                isActive
                  ? 'bg-[var(--bg-surface)] text-[var(--fg-primary)] shadow-[var(--shadow-low)] ring-1 ring-[var(--border-subtle)]'
                  : 'text-[var(--fg-secondary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]',
              )}
            >
              {isEditing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commitRename(chat.id);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1"
                >
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => void commitRename(chat.id)}
                    ref={(el) => {
                      if (el && document.activeElement !== el) el.focus();
                    }}
                    className="min-w-0 flex-1 rounded bg-[var(--bg-canvas)] px-1.5 py-0.5 text-xs text-[var(--fg-primary)] outline-none ring-1 ring-[var(--accent)]"
                  />
                  <button
                    type="submit"
                    className="rounded p-0.5 text-[var(--accent)]"
                    aria-label="Save chat title"
                  >
                    <Check className="size-3.5" />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onSelectChat(chat.id)}
                    className="flex min-w-0 flex-1 flex-col items-start text-left cursor-pointer"
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <MessageSquare className="size-3.5 shrink-0 opacity-60" />
                      <span className="truncate font-medium">{chat.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10px] text-[var(--fg-muted)]">
                      <span>{formatRelativeTime(chat.updatedAt)}</span>
                      {chat.visibility === 'public' && (
                        <span className="inline-flex items-center gap-0.5 text-[var(--accent)]">
                          · <Globe className="size-2.5" /> Shared
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Hover Quick Actions */}
                  <div className="hidden shrink-0 items-center gap-0.5 rounded-[var(--radius-inner)] bg-[var(--bg-surface)]/95 p-0.5 shadow-xs group-hover:flex">
                    <button
                      type="button"
                      onClick={() => void onTogglePinChat(chat.id, !chat.pinned)}
                      className={cn(
                        'rounded p-1 hover:bg-[var(--overlay-hover)]',
                        chat.pinned
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)]',
                      )}
                      title={chat.pinned ? 'Unpin chat' : 'Pin chat'}
                    >
                      <Pin className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(chat.id);
                        setEditingTitle(chat.title);
                      }}
                      className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                      title="Rename chat"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const nextVis = chat.visibility === 'public' ? 'private' : 'public';
                        void onToggleVisibility(chat.id, nextVis);
                        if (nextVis === 'public' && typeof window !== 'undefined') {
                          const shareUrl = `${window.location.origin}/chat/${chat.id}`;
                          void navigator.clipboard.writeText(shareUrl);
                          toast.success('Chat is now public — link copied');
                        }
                      }}
                      className={cn(
                        'rounded p-1 hover:bg-[var(--overlay-hover)]',
                        chat.visibility === 'public'
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)]',
                      )}
                      title={
                        chat.visibility === 'public' ? 'Make private' : 'Share publicly & copy link'
                      }
                    >
                      {chat.visibility === 'public' ? (
                        <Globe className="size-3" />
                      ) : (
                        <Lock className="size-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteChat(chat.id)}
                      className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--status-danger-soft)] hover:text-[var(--status-danger)]"
                      title="Delete chat"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close sidebar overlay"
        onClick={onCloseSidebar}
        className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] lg:hidden"
      />
      <aside
        aria-label="Workspace sidebar"
        className="fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] shadow-[var(--shadow-high)] lg:static lg:z-auto lg:shadow-none"
      >
        {/* Top Brand & Collapse */}
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex items-center gap-2 rounded-[var(--radius-inner)] px-1.5 py-1 text-left hover:bg-[var(--overlay-hover)] cursor-pointer"
          >
            <span className="flex size-6 items-center justify-center rounded-[8px] bg-[var(--accent)] font-mono text-xs font-bold text-[var(--accent-foreground)] shadow-[var(--shadow-low)]">
              A
            </span>
            <div className="leading-tight">
              <div className="text-xs font-semibold tracking-tight text-[var(--fg-primary)]">
                Web ADE
              </div>
              <div className="font-mono text-[9.5px] text-[var(--fg-muted)]">AI SDK 7 · Astryx</div>
            </div>
          </button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCloseSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        {/* New Chat Button */}
        <div className="px-3 pb-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onNewChat}
            className="w-full justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <Plus className="size-3.5" />
              New Chat
            </span>
            <Kbd>⇧⌘O</Kbd>
          </Button>
        </div>

        {/* Search Filter */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter conversations…"
              aria-label="Filter conversations"
              className="h-8 w-full rounded-[var(--radius-inner)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-7 pl-8 text-xs text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none focus:border-[var(--accent)]"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
                aria-label="Clear filter"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Grouped Chat History */}
        <nav className="astryx-scroll-shadow min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {grouped.total === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[var(--fg-muted)]">
              {search ? 'No matching chats.' : 'Your conversations will appear here.'}
            </div>
          ) : (
            <>
              {renderGroup('Pinned', grouped.pinned)}
              {renderGroup('Today', grouped.today)}
              {renderGroup('Previous', grouped.previous)}
            </>
          )}
        </nav>

        {/* Footer: Account / Sign in with Vercel + Quick Actions */}
        <div className="space-y-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/55 p-3">
          {sessionUser && !sessionUser.isGuest ? (
            <div className="flex items-center justify-between gap-2 rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">
                  {(sessionUser.name ?? sessionUser.email ?? 'V').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 leading-tight">
                  <div className="truncate text-xs font-medium text-[var(--fg-primary)]">
                    {sessionUser.name ?? 'Vercel User'}
                  </div>
                  <div className="truncate text-[10px] text-[var(--fg-muted)]">
                    {sessionUser.email ?? 'Connected'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  window.location.reload();
                }}
                className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                title="Sign out"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          ) : (
            <div className="rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-[var(--fg-primary)]">Guest Workspace</span>
                <span className="font-mono text-[10px] text-[var(--fg-muted)]">Active</span>
              </div>
              {vercelOAuthConfigured ? (
                <Button
                  variant="primary"
                  size="xs"
                  className="mt-2 w-full"
                  onClick={async () => {
                    try {
                      const res = await signInWithVercel(window.location.pathname || '/');
                      if (res && typeof res === 'object' && 'error' in res && res.error) {
                        const msg =
                          typeof res.error === 'object' &&
                          res.error !== null &&
                          'message' in res.error
                            ? String((res.error as { message?: string }).message ?? '')
                            : '';
                        toast.error(
                          msg ||
                            'Sign in with Vercel is not configured on this host (set VERCEL_CLIENT_ID & VERCEL_CLIENT_SECRET).',
                        );
                      }
                    } catch {
                      toast.error(
                        'Sign in with Vercel is not configured on this host (set VERCEL_CLIENT_ID & VERCEL_CLIENT_SECRET).',
                      );
                    }
                  }}
                >
                  <span>▲</span> Sign in with Vercel
                </Button>
              ) : (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="mt-1.5 text-[11px] font-medium text-[var(--accent)] hover:underline cursor-pointer"
                >
                  Add BYOK key or Custom Endpoint →
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={onOpenSettings}
              className="flex-1 justify-start"
            >
              <Settings className="size-3.5" />
              Settings
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={onCopyMcpUrl}
              title="Copy Remote MCP endpoint (/api/mcp)"
            >
              <Terminal className="size-3.5" />
              <Copy className="size-3" />
              MCP
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
