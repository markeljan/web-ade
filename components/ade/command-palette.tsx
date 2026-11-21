'use client';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemText,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@ui-sdk/react/command';
import {
  Activity,
  Bot,
  Check,
  Code2,
  Copy,
  Globe,
  Layers,
  Lock,
  MessageSquare,
  Mic,
  Moon,
  Palette,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type {
  AstryxPalette,
  ChatSummary,
  HarnessMode,
  ModelDefinition,
  ThemeMode,
  WorkbenchTab,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  chats: ChatSummary[];
  activeChatId?: string;
  models: ModelDefinition[];
  activeModelId: string;
  isUserBilled?: boolean;
  activeHarness: HarnessMode;
  workbenchOpen: boolean;
  activeWorkbenchTab: WorkbenchTab;
  theme: ThemeMode;
  palette: AstryxPalette;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onSelectModel: (modelId: string) => void;
  onSelectHarness: (harness: HarnessMode) => void;
  onToggleWorkbench: (open?: boolean) => void;
  onSelectWorkbenchTab: (tab: WorkbenchTab) => void;
  onSetTheme: (theme: ThemeMode) => void;
  onSetPalette: (palette: AstryxPalette) => void;
  onOpenSettings: () => void;
  onOpenVoice: () => void;
  onTestUiBridge: () => void;
  onCopyMcpUrl: () => void;
}

const HARNESS_OPTIONS: Array<{
  id: HarnessMode;
  label: string;
  detail: string;
}> = [
  { id: 'ai-sdk', label: 'AI SDK 7', detail: 'Universal ToolLoop + bash-tool' },
  { id: 'fx', label: 'fx (libfx)', detail: 'Durable Fluid Compute coding harness' },
  {
    id: 'workflow',
    label: 'Workflow 5',
    detail: 'Durable resumable multi-step agent',
  },
];

const WORKBENCH_TABS: Array<{
  id: WorkbenchTab;
  label: string;
  icon: typeof Globe;
}> = [
  { id: 'preview', label: 'Preview / Live App', icon: Globe },
  { id: 'browser', label: 'Live Browser / Desktop', icon: Globe },
  { id: 'terminal', label: 'Terminal (@wterm)', icon: Terminal },
  { id: 'files', label: 'Files & Canvas Editor', icon: Code2 },
  { id: 'genui', label: 'GenUI Canvas (json-render)', icon: Sparkles },
  { id: 'trace', label: 'Trace Waterfall', icon: Activity },
];

const PALETTES: Array<{ id: AstryxPalette; label: string; swatch: string }> = [
  { id: 'neutral', label: 'Neutral Cobalt', swatch: 'bg-[#0064E0]' },
  { id: 'stone', label: 'Warm Stone', swatch: 'bg-[#A16207]' },
  { id: 'matcha', label: 'Matcha Botanical', swatch: 'bg-[#15803D]' },
  { id: 'obsidian', label: 'Obsidian Violet', swatch: 'bg-[#7C3AED]' },
];

export function CommandPalette({
  open,
  onClose,
  chats,
  activeChatId,
  models,
  activeModelId,
  isUserBilled = false,
  activeHarness,
  workbenchOpen,
  activeWorkbenchTab,
  theme,
  palette,
  onSelectChat,
  onNewChat,
  onSelectModel,
  onSelectHarness,
  onToggleWorkbench,
  onSelectWorkbenchTab,
  onSetTheme,
  onSetPalette,
  onOpenSettings,
  onOpenVoice,
  onTestUiBridge,
  onCopyMcpUrl,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const runAction = (value: string) => {
    if (value === 'action:new-chat') {
      onNewChat();
    } else if (value === 'action:toggle-workbench') {
      onToggleWorkbench(!workbenchOpen);
    } else if (value === 'action:open-settings') {
      onOpenSettings();
    } else if (value === 'action:open-voice') {
      onOpenVoice();
    } else if (value === 'action:test-ui-bridge') {
      onTestUiBridge();
    } else if (value === 'action:copy-mcp') {
      onCopyMcpUrl();
    } else if (value.startsWith('chat:')) {
      onSelectChat(value.slice('chat:'.length));
    } else if (value.startsWith('model:')) {
      onSelectModel(value.slice('model:'.length));
    } else if (value.startsWith('harness:')) {
      onSelectHarness(value.slice('harness:'.length) as HarnessMode);
    } else if (value.startsWith('tab:')) {
      const tab = value.slice('tab:'.length) as WorkbenchTab;
      onToggleWorkbench(true);
      onSelectWorkbenchTab(tab);
    } else if (value.startsWith('theme:')) {
      onSetTheme(value.slice('theme:'.length) as ThemeMode);
    } else if (value.startsWith('palette:')) {
      onSetPalette(value.slice('palette:'.length) as AstryxPalette);
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-[var(--radius-container,16px)] border border-border bg-popover/98 shadow-2xl backdrop-blur-xl">
        <Command onAction={runAction} autoHighlight loop className="flex flex-col">
          {/* Search Input */}
          <div className="flex items-center gap-2.5 border-b border-border/70 px-3.5 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CommandInput
              ref={inputRef}
              aria-label="Search commands, models, chats, and workspace actions"
              placeholder="Search chats, switch models, open Workbench, or run actions…"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close command palette"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <CommandList className="max-h-[60vh] overflow-y-auto p-2 text-xs">
            {/* Quick Actions */}
            <CommandGroup>
              <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Quick Actions
              </CommandGroupLabel>
              <CommandItem
                value="action:new-chat"
                label="New Chat"
                keywords={['create', 'reset', 'conversation']}
                shortcut="mod+shift+o"
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                <CommandItemText className="flex-1 text-foreground [&_mark]:bg-[var(--accent)]/20 [&_mark]:text-foreground [&_mark]:rounded-xs">
                  New Chat
                </CommandItemText>
                <CommandShortcut
                  shortcut="mod+shift+o"
                  className="font-mono text-[10px] text-muted-foreground"
                />
              </CommandItem>

              <CommandItem
                value="action:toggle-workbench"
                label={workbenchOpen ? 'Hide Workbench' : 'Open Workbench'}
                keywords={['drawer', 'split', 'panel', 'canvas']}
                shortcut="mod+."
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
                <CommandItemText className="flex-1 text-foreground">
                  {workbenchOpen ? 'Hide Workbench' : 'Open Workbench'}
                </CommandItemText>
                <CommandShortcut
                  shortcut="mod+."
                  className="font-mono text-[10px] text-muted-foreground"
                />
              </CommandItem>

              <CommandItem
                value="action:open-voice"
                label="Open Live Realtime Voice"
                keywords={['audio', 'mic', 'speak', 'orb']}
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <Mic className="h-3.5 w-3.5 text-muted-foreground" />
                <CommandItemText className="flex-1 text-foreground">
                  Open Live Realtime Voice
                </CommandItemText>
              </CommandItem>

              <CommandItem
                value="action:test-ui-bridge"
                label="Test Self-Operating UI Agent Bridge"
                keywords={['ui-sdk', 'agent', 'demo', 'self-operating']}
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <Wand2 className="h-3.5 w-3.5 text-[var(--accent)]" />
                <CommandItemText className="flex-1 text-foreground">
                  Test Self-Operating UI Agent Bridge
                </CommandItemText>
                <span className="rounded-full bg-[var(--accent)]/12 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  @ui-sdk/react
                </span>
              </CommandItem>

              <CommandItem
                value="action:copy-mcp"
                label="Copy Remote MCP Server URL"
                keywords={['mcp', 'endpoint', 'claude', 'cursor', 'fx']}
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                <CommandItemText className="flex-1 text-foreground">
                  Copy Remote MCP Endpoint (/api/mcp)
                </CommandItemText>
              </CommandItem>

              <CommandItem
                value="action:open-settings"
                label="Open Settings & Providers"
                keywords={['byok', 'api key', 'billing', 'vercel', 'oauth', 'theme']}
                className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-2 cursor-pointer data-[highlighted]:bg-muted"
              >
                <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                <CommandItemText className="flex-1 text-foreground">
                  Settings, Providers & Billing Waterfall
                </CommandItemText>
              </CommandItem>
            </CommandGroup>

            <CommandSeparator className="my-1.5 h-px bg-border/60" />

            {/* Workbench Tabs */}
            <CommandGroup>
              <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Workbench Panes
              </CommandGroupLabel>
              {WORKBENCH_TABS.map((t) => {
                const Icon = t.icon;
                const isActive = workbenchOpen && activeWorkbenchTab === t.id;
                return (
                  <CommandItem
                    key={t.id}
                    value={`tab:${t.id}`}
                    label={`Workbench: ${t.label}`}
                    keywords={['workbench', t.id, t.label]}
                    className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted"
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <CommandItemText className="flex-1 text-foreground">{t.label}</CommandItemText>
                    {isActive && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>

            <CommandSeparator className="my-1.5 h-px bg-border/60" />

            {/* Switch Harness */}
            <CommandGroup>
              <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Agent Harness
              </CommandGroupLabel>
              {HARNESS_OPTIONS.map((h) => (
                <CommandItem
                  key={h.id}
                  value={`harness:${h.id}`}
                  label={`Harness: ${h.label}`}
                  keywords={['harness', h.id, h.detail]}
                  className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted"
                >
                  <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <CommandItemText className="font-medium text-foreground">
                      {h.label}
                    </CommandItemText>
                    <span className="ml-2 text-[11px] text-muted-foreground">{h.detail}</span>
                  </div>
                  {activeHarness === h.id && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator className="my-1.5 h-px bg-border/60" />

            {/* Switch Model */}
            <CommandGroup>
              <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Models
              </CommandGroupLabel>
              {models.map((m) => {
                const isLocked = !isUserBilled && !m.sponsoredEligible;
                return (
                  <CommandItem
                    key={m.id}
                    value={`model:${m.id}`}
                    label={`${m.name} (${m.id})`}
                    keywords={[
                      m.provider,
                      m.tier,
                      isLocked ? 'byok' : 'sponsored',
                      ...m.capabilities,
                    ]}
                    className={cn(
                      'flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted',
                      isLocked && 'opacity-70',
                    )}
                  >
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <CommandItemText className="font-medium text-foreground">
                        {m.name}
                      </CommandItemText>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {m.id}
                      </span>
                    </div>
                    {isLocked ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                        <Lock className="h-2.5 w-2.5" />
                        BYOK
                      </span>
                    ) : (
                      activeModelId === m.id && (
                        <Check className="h-3.5 w-3.5 text-[var(--accent)]" />
                      )
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>

            {/* Recent Chats */}
            {chats.length > 0 && (
              <>
                <CommandSeparator className="my-1.5 h-px bg-border/60" />
                <CommandGroup>
                  <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Recent Chats
                  </CommandGroupLabel>
                  {chats.slice(0, 8).map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`chat:${c.id}`}
                      label={c.title}
                      keywords={['chat', 'history', c.modelId]}
                      className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted"
                    >
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      <CommandItemText className="flex-1 truncate text-foreground">
                        {c.title}
                      </CommandItemText>
                      {activeChatId === c.id && (
                        <Check className="h-3.5 w-3.5 text-[var(--accent)]" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            <CommandSeparator className="my-1.5 h-px bg-border/60" />

            {/* Theme & Astryx Palettes */}
            <CommandGroup>
              <CommandGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Astryx Appearance
              </CommandGroupLabel>
              {(
                [
                  ['light', 'Light Mode', Sun],
                  ['dark', 'Dark Mode', Moon],
                  ['system', 'System Theme', Palette],
                ] as const
              ).map(([mode, label, Icon]) => (
                <CommandItem
                  key={mode}
                  value={`theme:${mode}`}
                  label={`Theme: ${label}`}
                  keywords={['appearance', 'color', mode]}
                  className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <CommandItemText className="flex-1 text-foreground">{label}</CommandItemText>
                  {theme === mode && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}
                </CommandItem>
              ))}
              {PALETTES.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`palette:${p.id}`}
                  label={`Palette: ${p.label}`}
                  keywords={['astryx', 'palette', 'theme', p.id]}
                  className="flex items-center gap-2.5 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 cursor-pointer data-[highlighted]:bg-muted"
                >
                  <span className={cn('h-3 w-3 rounded-full shrink-0', p.swatch)} />
                  <CommandItemText className="flex-1 text-foreground">
                    Astryx Palette: {p.label}
                  </CommandItemText>
                  {palette === p.id && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>

          <CommandEmpty className="px-4 py-8 text-center text-xs text-muted-foreground">
            No matching commands, models, or chats.
          </CommandEmpty>

          <div className="flex items-center justify-between border-t border-border/60 bg-muted/25 px-3.5 py-2 text-[10.5px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span>↑↓ Navigate</span>
              <span>↵ Run</span>
              <span>Esc Close</span>
            </div>
            <span className="font-mono">@ui-sdk/react/command</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
