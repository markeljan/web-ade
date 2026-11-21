'use client';

import {
  type AgentComponent,
  type AgentStep,
  agentTools,
  createAgent,
  registerTools,
} from '@ui-sdk/react/agent';
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Play,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  applyThemeToDocument,
  isAstryxPalette,
  isThemeMode,
  readStoredAstryxPalette,
  readStoredThemeMode,
  setAstryxPalette,
  setThemeMode,
} from '@/lib/theme/astryx-tokens';
import type {
  AstryxPalette,
  BrowserStreamMode,
  HarnessMode,
  ThemeMode,
  UiAgentAction,
  UiAgentCommand,
  UiAgentComponentSummary,
  UiAgentSnapshot,
  WorkbenchTab,
} from '@/lib/types';
import { cn, formatRelativeTime, generateId } from '@/lib/utils';

export interface UiAgentControllerBindings {
  route?: string;
  theme?: ThemeMode;
  palette?: AstryxPalette;
  modelId?: string;
  harnessMode?: HarnessMode;
  workbenchOpen?: boolean;
  activeTab?: WorkbenchTab;
  sidebarOpen?: boolean;
  browserMode?: BrowserStreamMode;
  browserUrl?: string;
  onSetTheme?: (theme: ThemeMode) => void;
  onSetPalette?: (palette: AstryxPalette) => void;
  onSetWorkbenchOpen?: (open: boolean) => void;
  onSetWorkbenchTab?: (tab: WorkbenchTab) => void;
  onSetModel?: (modelId: string) => void;
  onSetHarness?: (harness: HarnessMode) => void;
  onOpenCommandPalette?: () => void;
  onOpenSettings?: (tab?: string) => void;
  onToggleSidebar?: (open?: boolean) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserTakeControl?: () => void;
  onBrowserReleaseControl?: () => void;
  onTerminalRun?: (command: string) => void;
  onNewChat?: () => void;
}

export interface UiAgentAuditEntry {
  id: string;
  timestamp: number;
  action: UiAgentAction | 'ui-sdk-observe';
  ref?: string;
  args?: Record<string, unknown>;
  status: 'executed' | 'denied' | 'error';
  message: string;
  source: 'agent' | 'demo' | 'webmcp';
}

export interface UiAgentActResult {
  ok: boolean;
  executed: number;
  results: Array<{
    action: UiAgentAction;
    ok: boolean;
    message: string;
  }>;
  snapshot: UiAgentSnapshot;
}

export interface UiAgentContextValue {
  /** Register or update live ADE workspace state & handlers from AdeShell */
  registerController: (bindings: UiAgentControllerBindings) => void;
  /** Capture a live semantic snapshot combining ADE controls & @ui-sdk/react/agent components */
  snapshot: () => UiAgentSnapshot;
  /** Execute one or more semantic UI commands or raw @ui-sdk/react/agent steps */
  act: (
    commands: UiAgentCommand[],
    options?: { source?: 'agent' | 'demo' | 'webmcp'; bypassApproval?: boolean },
  ) => Promise<UiAgentActResult>;
  /** Run a live choreographed demonstration of the self-operating ADE UI */
  runDemo: () => Promise<void>;
  /** Number of currently exposed semantic UI targets */
  targetCount: number;
  /** Latest cached snapshot for reactive badges and popovers */
  lastSnapshot: UiAgentSnapshot;
  /** Recent UI Bridge actions audit log */
  auditLog: UiAgentAuditEntry[];
  clearAuditLog: () => void;
  /** Require human approval before executing agent UI mutations */
  requireApproval: boolean;
  setRequireApproval: (require: boolean) => void;
  /** Optional browser WebMCP exposure via @ui-sdk/react/agent registerTools */
  webMcpEnabled: boolean;
  setWebMcpEnabled: (enabled: boolean) => void;
  /** Exposed JSON Schema tool definitions from @ui-sdk/react/agent */
  sdkToolSchemas: typeof agentTools;
}

const DEFAULT_SNAPSHOT: UiAgentSnapshot = {
  route: '/',
  theme: 'system',
  palette: 'neutral',
  modelId: 'anthropic/claude-haiku-5.5',
  harnessMode: 'ai-sdk',
  workbenchOpen: false,
  activeTab: 'preview',
  sidebarOpen: true,
  browserMode: 'preview',
  components: [],
};

const UiAgentContext = React.createContext<UiAgentContextValue | null>(null);

function normalizeSdkComponent(comp: AgentComponent): UiAgentComponentSummary {
  const value =
    'value' in comp
      ? comp.value
      : 'checked' in comp
        ? comp.checked
        : 'open' in comp
          ? comp.open
          : undefined;
  return {
    ref: comp.ref,
    role: comp.component,
    label: comp.label ?? comp.row ?? comp.component,
    value,
    actions: Array.isArray(comp.actions) ? comp.actions : [],
  };
}

function buildCoreAdeTargets(state: UiAgentControllerBindings): UiAgentComponentSummary[] {
  const theme = state.theme ?? 'system';
  const palette = state.palette ?? 'neutral';
  const modelId = state.modelId ?? 'anthropic/claude-haiku-5.5';
  const harnessMode = state.harnessMode ?? 'ai-sdk';
  const workbenchOpen = Boolean(state.workbenchOpen);
  const activeTab = state.activeTab ?? 'preview';
  const sidebarOpen = state.sidebarOpen ?? true;
  const browserMode = state.browserMode ?? 'preview';

  return [
    {
      ref: 'ade.theme',
      role: 'color-scheme',
      label: 'Color Scheme',
      value: theme,
      actions: ['set-theme(light|dark|system)'],
    },
    {
      ref: 'ade.palette',
      role: 'theme-palette',
      label: 'Astryx Palette',
      value: palette,
      actions: ['set-palette(neutral|stone|matcha|obsidian)'],
    },
    {
      ref: 'ade.workbench',
      role: 'panel',
      label: 'Workbench Drawer',
      value: workbenchOpen ? 'open' : 'closed',
      actions: ['set-workbench-open(boolean)'],
    },
    {
      ref: 'ade.workbench.tab',
      role: 'tabs',
      label: 'Workbench Active Tab',
      value: activeTab,
      actions: ['set-workbench-tab(preview|browser|terminal|files|genui|trace)'],
    },
    {
      ref: 'ade.model',
      role: 'select',
      label: 'Active Model',
      value: modelId,
      actions: ['set-model(modelId)'],
    },
    {
      ref: 'ade.harness',
      role: 'segmented-control',
      label: 'Agent Harness',
      value: harnessMode,
      actions: ['set-harness(ai-sdk|fx|workflow)'],
    },
    {
      ref: 'ade.sidebar',
      role: 'navigation',
      label: 'Chat Sidebar',
      value: sidebarOpen ? 'open' : 'closed',
      actions: ['toggle-sidebar(boolean?)'],
    },
    {
      ref: 'ade.browser',
      role: 'browser-pane',
      label: 'Embedded Browser',
      value: state.browserUrl ? `${browserMode} (${state.browserUrl})` : browserMode,
      actions: ['browser-navigate(url)', 'browser-take-control()', 'browser-release-control()'],
    },
    {
      ref: 'ade.terminal',
      role: 'terminal-pane',
      label: 'Web Terminal',
      value: 'ready',
      actions: ['terminal-run(command)'],
    },
    {
      ref: 'ade.command-palette',
      role: 'dialog',
      label: 'Command Palette (⌘K)',
      value: 'ready',
      actions: ['open-command-palette()'],
    },
    {
      ref: 'ade.settings',
      role: 'dialog',
      label: 'Settings & Providers',
      value: 'ready',
      actions: ['open-settings(tab?)'],
    },
    {
      ref: 'ade.new-chat',
      role: 'button',
      label: 'New Chat',
      value: 'ready',
      actions: ['new-chat()'],
    },
  ];
}

const UI_BRIDGE_APPROVAL_STORAGE_KEY = 'ade:ui-bridge:require-approval';

export function UiAgentProvider({ children }: { children: React.ReactNode }) {
  const bindingsRef = React.useRef<UiAgentControllerBindings>({});
  const requireApprovalRef = React.useRef<boolean>(true);
  const sdkAgentRef = React.useRef<ReturnType<typeof createAgent> | null>(null);

  const [requireApproval, setRequireApprovalState] = React.useState(true);
  const [webMcpEnabled, setWebMcpEnabled] = React.useState(false);
  const [auditLog, setAuditLog] = React.useState<UiAgentAuditEntry[]>([]);
  const [version, setVersion] = React.useState(0);

  // Hydrate persisted requireApproval preference after mount (defaults safely to true)
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(UI_BRIDGE_APPROVAL_STORAGE_KEY);
      if (saved === 'false') {
        requireApprovalRef.current = false;
        setRequireApprovalState(false);
      } else if (saved === 'true') {
        requireApprovalRef.current = true;
        setRequireApprovalState(true);
      }
    } catch {
      // Ignore storage access errors in restricted contexts
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_BRIDGE_APPROVAL_STORAGE_KEY) return;
      const next = event.newValue !== 'false';
      requireApprovalRef.current = next;
      setRequireApprovalState(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setRequireApproval = React.useCallback((next: boolean) => {
    requireApprovalRef.current = next;
    setRequireApprovalState(next);
    try {
      window.localStorage.setItem(UI_BRIDGE_APPROVAL_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage write errors
    }
  }, []);

  const appendAudit = React.useCallback((entry: Omit<UiAgentAuditEntry, 'id' | 'timestamp'>) => {
    setAuditLog((prev) => [
      {
        ...entry,
        id: generateId('uia', 8),
        timestamp: Date.now(),
      },
      ...prev.slice(0, 29),
    ]);
  }, []);

  // Initialize native @ui-sdk/react/agent instance on the client
  if (typeof window !== 'undefined' && sdkAgentRef.current === null) {
    sdkAgentRef.current = createAgent({
      allow: (step) => {
        if (step.confirm && requireApprovalRef.current) {
          return window.confirm(`Allow UI Agent to ${step.action} on "${step.label ?? step.ref}"?`);
        }
        return true;
      },
    });
  }

  // Subscribe to @ui-sdk/react/agent DOM primitive changes & optional WebMCP registration
  React.useEffect(() => {
    const agent = sdkAgentRef.current;
    if (!agent) {
      return;
    }

    const unsubscribe = agent.subscribe((change) => {
      if (change.source === 'agent') {
        appendAudit({
          action: 'ui-sdk-observe',
          ref: change.ref,
          args: { key: change.key, value: change.value },
          status: 'executed',
          message: `Observed ${change.component} (${change.label ?? change.ref}) -> ${String(change.value)}`,
          source: 'agent',
        });
      }
      setVersion((v) => v + 1);
    });

    return () => {
      unsubscribe();
    };
  }, [appendAudit]);

  React.useEffect(() => {
    const agent = sdkAgentRef.current;
    if (!agent || !webMcpEnabled) {
      return;
    }

    const unregister = registerTools(agent, {
      allow: (step) => {
        if (!requireApprovalRef.current) {
          return true;
        }
        return window.confirm(
          `WebMCP agent wants to run "${step.action}" on ${step.label ?? step.ref}. Allow?`,
        );
      },
    });

    return () => {
      unregister();
    };
  }, [webMcpEnabled]);

  const registerController = React.useCallback((next: UiAgentControllerBindings) => {
    const prev = bindingsRef.current;
    const merged: UiAgentControllerBindings = {
      ...prev,
      ...next,
    };
    const stateChanged =
      prev.route !== merged.route ||
      prev.theme !== merged.theme ||
      prev.palette !== merged.palette ||
      prev.modelId !== merged.modelId ||
      prev.harnessMode !== merged.harnessMode ||
      prev.workbenchOpen !== merged.workbenchOpen ||
      prev.activeTab !== merged.activeTab ||
      prev.sidebarOpen !== merged.sidebarOpen ||
      prev.browserMode !== merged.browserMode ||
      prev.browserUrl !== merged.browserUrl;
    bindingsRef.current = merged;
    if (stateChanged) {
      setVersion((v) => v + 1);
    }
  }, []);

  const snapshot = React.useCallback((): UiAgentSnapshot => {
    const b = bindingsRef.current;
    const theme = b.theme ?? readStoredThemeMode();
    const palette = b.palette ?? readStoredAstryxPalette();
    const coreTargets = buildCoreAdeTargets({ ...b, theme, palette });

    let sdkComponents: UiAgentComponentSummary[] = [];
    if (sdkAgentRef.current) {
      try {
        sdkComponents = sdkAgentRef.current
          .snapshot()
          .filter((item) => !item.offPage && item.component !== 'more')
          .slice(0, 24)
          .map(normalizeSdkComponent);
      } catch {
        sdkComponents = [];
      }
    }

    return {
      route:
        b.route ??
        (typeof window !== 'undefined' ? window.location.pathname : DEFAULT_SNAPSHOT.route),
      theme,
      palette,
      modelId: b.modelId ?? DEFAULT_SNAPSHOT.modelId,
      harnessMode: b.harnessMode ?? DEFAULT_SNAPSHOT.harnessMode,
      workbenchOpen: b.workbenchOpen ?? DEFAULT_SNAPSHOT.workbenchOpen,
      activeTab: b.activeTab ?? DEFAULT_SNAPSHOT.activeTab,
      sidebarOpen: b.sidebarOpen ?? DEFAULT_SNAPSHOT.sidebarOpen,
      browserMode: b.browserMode ?? DEFAULT_SNAPSHOT.browserMode,
      components: [...coreTargets, ...sdkComponents],
    };
  }, []);

  const act = React.useCallback(
    async (
      commands: UiAgentCommand[],
      options?: { source?: 'agent' | 'demo' | 'webmcp'; bypassApproval?: boolean },
    ): Promise<UiAgentActResult> => {
      const source = options?.source ?? 'agent';
      const results: UiAgentActResult['results'] = [];

      for (const cmd of commands) {
        const b = bindingsRef.current;
        const args = cmd.args ?? {};

        if (
          !options?.bypassApproval &&
          (requireApprovalRef.current || cmd.requiresApproval) &&
          typeof window !== 'undefined'
        ) {
          const confirmed = window.confirm(
            `Allow UI Agent to execute "${cmd.action}"${cmd.reason ? ` (${cmd.reason})` : ''}?`,
          );
          if (!confirmed) {
            const msg = `Denied by user: ${cmd.action}`;
            appendAudit({
              action: cmd.action,
              ref: cmd.ref,
              args,
              status: 'denied',
              message: msg,
              source,
            });
            results.push({ action: cmd.action, ok: false, message: msg });
            continue;
          }
        }

        try {
          let message = `Executed ${cmd.action}`;

          switch (cmd.action) {
            case 'set-theme': {
              const raw = args.theme ?? args.mode ?? args.value;
              if (!isThemeMode(raw)) {
                throw new Error(`Invalid theme mode: ${String(raw)}`);
              }
              setThemeMode(raw);
              applyThemeToDocument(raw);
              b.onSetTheme?.(raw);
              bindingsRef.current.theme = raw;
              message = `Switched color scheme to ${raw}`;
              break;
            }
            case 'set-palette': {
              const raw = args.palette ?? args.theme ?? args.value;
              if (!isAstryxPalette(raw)) {
                throw new Error(`Invalid Astryx palette: ${String(raw)}`);
              }
              setAstryxPalette(raw);
              b.onSetPalette?.(raw);
              bindingsRef.current.palette = raw;
              message = `Switched Astryx palette to ${raw}`;
              break;
            }
            case 'set-workbench-open': {
              const open = Boolean(args.open ?? args.value ?? true);
              b.onSetWorkbenchOpen?.(open);
              bindingsRef.current.workbenchOpen = open;
              message = open ? 'Opened Workbench drawer' : 'Closed Workbench drawer';
              break;
            }
            case 'set-workbench-tab': {
              const tab = String(args.tab ?? args.value ?? 'preview') as WorkbenchTab;
              b.onSetWorkbenchOpen?.(true);
              b.onSetWorkbenchTab?.(tab);
              bindingsRef.current.workbenchOpen = true;
              bindingsRef.current.activeTab = tab;
              message = `Switched Workbench tab to ${tab}`;
              break;
            }
            case 'set-model': {
              const modelId = String(args.modelId ?? args.model ?? args.value ?? '');
              if (!modelId) {
                throw new Error('Missing modelId');
              }
              b.onSetModel?.(modelId);
              bindingsRef.current.modelId = modelId;
              message = `Switched active model to ${modelId}`;
              break;
            }
            case 'set-harness': {
              const harness = String(
                args.harness ?? args.harnessMode ?? args.value ?? 'ai-sdk',
              ) as HarnessMode;
              b.onSetHarness?.(harness);
              bindingsRef.current.harnessMode = harness;
              message = `Switched agent harness to ${harness}`;
              break;
            }
            case 'open-command-palette': {
              b.onOpenCommandPalette?.();
              message = 'Opened Command Palette (⌘K)';
              break;
            }
            case 'open-settings': {
              const tab = typeof args.tab === 'string' ? args.tab : undefined;
              b.onOpenSettings?.(tab);
              message = tab ? `Opened Settings (${tab})` : 'Opened Settings dialog';
              break;
            }
            case 'toggle-sidebar': {
              const nextOpen =
                typeof args.open === 'boolean' ? args.open : !(b.sidebarOpen ?? true);
              b.onToggleSidebar?.(nextOpen);
              bindingsRef.current.sidebarOpen = nextOpen;
              message = nextOpen ? 'Expanded sidebar' : 'Collapsed sidebar';
              break;
            }
            case 'browser-navigate': {
              const url = String(args.url ?? '');
              if (!url) {
                throw new Error('Missing URL');
              }
              b.onSetWorkbenchOpen?.(true);
              b.onSetWorkbenchTab?.('browser');
              b.onBrowserNavigate?.(url);
              bindingsRef.current.workbenchOpen = true;
              bindingsRef.current.activeTab = 'browser';
              bindingsRef.current.browserUrl = url;
              message = `Navigated browser pane to ${url}`;
              break;
            }
            case 'browser-take-control': {
              b.onSetWorkbenchOpen?.(true);
              b.onSetWorkbenchTab?.('browser');
              b.onBrowserTakeControl?.();
              message = 'Handed browser control to human operator';
              break;
            }
            case 'browser-release-control': {
              b.onBrowserReleaseControl?.();
              message = 'Returned browser control to agent';
              break;
            }
            case 'terminal-run': {
              const command = String(args.command ?? '');
              if (!command) {
                throw new Error('Missing terminal command');
              }
              b.onSetWorkbenchOpen?.(true);
              b.onSetWorkbenchTab?.('terminal');
              b.onTerminalRun?.(command);
              message = `Dispatched command to terminal: ${command}`;
              break;
            }
            case 'new-chat': {
              b.onNewChat?.();
              message = 'Started a new conversation';
              break;
            }
            case 'ui-sdk-act': {
              const agent = sdkAgentRef.current;
              if (!agent) {
                throw new Error('UI SDK agent not mounted in browser');
              }
              const steps = Array.isArray(args.steps)
                ? (args.steps as AgentStep[])
                : cmd.ref && typeof args.sdkAction === 'string'
                  ? [
                      {
                        ref: cmd.ref,
                        action: args.sdkAction,
                        args: Array.isArray(args.sdkArgs) ? args.sdkArgs : undefined,
                      },
                    ]
                  : [];
              if (steps.length === 0) {
                throw new Error('No @ui-sdk/react/agent steps provided');
              }
              const sdkOutcome = await agent.act({ steps });
              if (!sdkOutcome.ok) {
                throw new Error(sdkOutcome.error?.message ?? 'UI SDK step failed');
              }
              message = `Ran ${steps.length} @ui-sdk/react/agent step(s)`;
              break;
            }
            default:
              throw new Error(`Unsupported UI action: ${String(cmd.action)}`);
          }

          appendAudit({
            action: cmd.action,
            ref: cmd.ref,
            args,
            status: 'executed',
            message,
            source,
          });
          results.push({ action: cmd.action, ok: true, message });
        } catch (error) {
          const errMessage = error instanceof Error ? error.message : 'Unknown UI Bridge error';
          appendAudit({
            action: cmd.action,
            ref: cmd.ref,
            args,
            status: 'error',
            message: errMessage,
            source,
          });
          results.push({ action: cmd.action, ok: false, message: errMessage });
        }
      }

      setVersion((v) => v + 1);
      const nextSnapshot = snapshot();
      return {
        ok: results.every((r) => r.ok),
        executed: results.filter((r) => r.ok).length,
        results,
        snapshot: nextSnapshot,
      };
    },
    [appendAudit, snapshot],
  );

  const runDemo = React.useCallback(async () => {
    const current = snapshot();
    const paletteOrder: AstryxPalette[] = ['neutral', 'matcha', 'stone', 'obsidian'];
    const nextPalette =
      paletteOrder[(paletteOrder.indexOf(current.palette) + 1) % paletteOrder.length];
    const nextTab: WorkbenchTab =
      current.workbenchOpen && current.activeTab === 'trace' ? 'files' : 'trace';

    const outcome = await act(
      [
        {
          action: 'set-palette',
          ref: 'ade.palette',
          args: { palette: nextPalette },
          reason: 'Demonstrate semantic palette switch via @ui-sdk/react/agent',
        },
        {
          action: 'set-workbench-open',
          ref: 'ade.workbench',
          args: { open: true },
          reason: 'Open Workbench drawer',
        },
        {
          action: 'set-workbench-tab',
          ref: 'ade.workbench.tab',
          args: { tab: nextTab },
          reason: `Switch Workbench to ${nextTab}`,
        },
      ],
      { source: 'demo', bypassApproval: true },
    );

    if (outcome.ok) {
      toast.success(`UI Bridge executed ${outcome.executed} actions`, {
        description: `Switched palette to ${nextPalette} and opened Workbench (${nextTab}).`,
      });
    }
  }, [act, snapshot]);

  const clearAuditLog = React.useCallback(() => {
    setAuditLog([]);
  }, []);

  // Recompute reactive snapshot whenever version ticks
  const lastSnapshot = React.useMemo(() => {
    void version;
    return snapshot();
  }, [snapshot, version]);

  const value = React.useMemo<UiAgentContextValue>(
    () => ({
      registerController,
      snapshot,
      act,
      runDemo,
      targetCount: lastSnapshot.components.length,
      lastSnapshot,
      auditLog,
      clearAuditLog,
      requireApproval,
      setRequireApproval,
      webMcpEnabled,
      setWebMcpEnabled,
      sdkToolSchemas: agentTools,
    }),
    [
      registerController,
      snapshot,
      act,
      runDemo,
      lastSnapshot,
      auditLog,
      clearAuditLog,
      requireApproval,
      setRequireApproval,
      webMcpEnabled,
    ],
  );

  return <UiAgentContext.Provider value={value}>{children}</UiAgentContext.Provider>;
}

export function useUiAgent(): UiAgentContextValue {
  const ctx = React.useContext(UiAgentContext);
  if (!ctx) {
    throw new Error('useUiAgent must be used inside <UiAgentProvider>');
  }
  return ctx;
}

export interface UiBridgePopoverProps {
  className?: string;
}

/**
 * Compact top-bar badge & live semantic tree inspector for `@ui-sdk/react/agent`.
 */
export function UiBridgePopover({ className }: UiBridgePopoverProps) {
  const {
    targetCount,
    lastSnapshot,
    auditLog,
    clearAuditLog,
    requireApproval,
    setRequireApproval,
    webMcpEnabled,
    setWebMcpEnabled,
    runDemo,
    snapshot,
  } = useUiAgent();

  const [liveSnap, setLiveSnap] = React.useState<UiAgentSnapshot>(lastSnapshot);
  const [activeView, setActiveView] = React.useState<'targets' | 'audit'>('targets');
  const [isDemoRunning, setIsDemoRunning] = React.useState(false);

  React.useEffect(() => {
    setLiveSnap(lastSnapshot);
  }, [lastSnapshot]);

  const handleRefresh = () => {
    setLiveSnap(snapshot());
  };

  const handleRunDemo = async () => {
    setIsDemoRunning(true);
    try {
      await runDemo();
      setLiveSnap(snapshot());
    } finally {
      setIsDemoRunning(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`UI Agent Bridge: ${targetCount} live targets`}
        data-slot="ui-bridge-trigger"
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-full)]',
          'border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--fg-secondary)]',
          'shadow-[var(--shadow-low)] hover:border-[var(--border-strong)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
          className,
        )}
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--status-success)] opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-[var(--status-success)]" />
        </span>
        <Cpu className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
        <span className="hidden sm:inline">UI Bridge</span>
        <span className="rounded-[var(--radius-full)] bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--fg-primary)]">
          {targetCount}
        </span>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-start justify-between gap-2 p-3.5 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-[var(--radius-inner)] bg-[var(--accent-soft)] text-[var(--accent)]">
              <Bot className="size-4" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs font-semibold text-[var(--fg-primary)]">
                  Self-Operating UI Bridge
                </h3>
                <Badge variant="accent" className="text-[10px]">
                  ui-sdk/agent
                </Badge>
              </div>
              <p className="text-[11px] text-[var(--fg-muted)]">
                {liveSnap.components.length} semantic targets live on {liveSnap.route}
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            aria-label="Refresh semantic snapshot"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
        </div>

        <div className="px-3.5 pb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleRunDemo}
            disabled={isDemoRunning}
            className="w-full justify-center gap-1.5"
          >
            <Play className="size-3.5" aria-hidden="true" />
            {isDemoRunning ? 'Operating UI…' : 'Demo Self-Operating UI'}
          </Button>
        </div>

        <Separator />

        <div className="flex flex-col gap-2.5 px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="ui-bridge-approval-toggle"
              className="flex items-center gap-2 text-xs text-[var(--fg-primary)] cursor-pointer"
            >
              {requireApproval ? (
                <ShieldAlert className="size-3.5 text-[var(--status-warning)]" aria-hidden="true" />
              ) : (
                <Shield className="size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
              )}
              <span>Require approval before UI acts</span>
            </label>
            <Switch
              id="ui-bridge-approval-toggle"
              checked={requireApproval}
              onCheckedChange={setRequireApproval}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="ui-bridge-webmcp-toggle"
              className="flex items-center gap-2 text-xs text-[var(--fg-primary)] cursor-pointer"
            >
              <Sparkles className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
              <span>Expose via browser WebMCP</span>
            </label>
            <Switch
              id="ui-bridge-webmcp-toggle"
              checked={webMcpEnabled}
              onCheckedChange={setWebMcpEnabled}
            />
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between px-3.5 pt-2.5 pb-1.5">
          <div className="inline-flex rounded-[var(--radius-inner)] bg-[var(--bg-surface-subtle)] p-0.5">
            <button
              type="button"
              onClick={() => setActiveView('targets')}
              className={cn(
                'cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium',
                activeView === 'targets'
                  ? 'bg-[var(--bg-surface)] text-[var(--fg-primary)] shadow-[var(--shadow-low)]'
                  : 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)]',
              )}
            >
              Semantic Tree ({liveSnap.components.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveView('audit')}
              className={cn(
                'cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium',
                activeView === 'audit'
                  ? 'bg-[var(--bg-surface)] text-[var(--fg-primary)] shadow-[var(--shadow-low)]'
                  : 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)]',
              )}
            >
              Audit Log ({auditLog.length})
            </button>
          </div>
          {activeView === 'audit' && auditLog.length > 0 && (
            <button
              type="button"
              onClick={clearAuditLog}
              className="cursor-pointer text-[11px] font-medium text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
            >
              Clear
            </button>
          )}
        </div>

        <div className="astryx-scroll-shadow max-h-64 px-3.5 pb-3.5">
          {activeView === 'targets' ? (
            <ul className="flex flex-col gap-1.5 pt-1">
              {liveSnap.components.map((item) => (
                <li
                  key={item.ref}
                  className="rounded-[var(--radius-inner)] border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] font-semibold text-[var(--fg-primary)]">
                      {item.ref}
                    </span>
                    {item.value !== undefined && (
                      <span className="max-w-[140px] truncate rounded-[6px] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-secondary)]">
                        {String(item.value)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
                    <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.actions.join(', ') || item.role}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : auditLog.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
              <Activity className="size-4 text-[var(--fg-muted)]" aria-hidden="true" />
              <p className="text-xs text-[var(--fg-muted)]">
                No agent UI actions yet. Click Demo or ask the assistant to switch theme or open a
                pane.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5 pt-1">
              {auditLog.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-[var(--radius-inner)] border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {entry.status === 'executed' ? (
                        <CheckCircle2
                          className="size-3.5 text-[var(--status-success)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <XCircle
                          className="size-3.5 text-[var(--status-danger)]"
                          aria-hidden="true"
                        />
                      )}
                      <span className="font-mono text-[11px] font-semibold text-[var(--fg-primary)]">
                        {entry.action}
                      </span>
                    </div>
                    <span className="text-[10px] text-[var(--fg-muted)]">
                      {formatRelativeTime(entry.timestamp)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-[var(--fg-secondary)]">
                    {entry.message}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
