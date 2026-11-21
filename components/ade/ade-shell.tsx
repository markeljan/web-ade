'use client';

import type { Spec } from '@json-render/react';
import {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from '@ui-sdk/react/resizable';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AdeUIMessage, ChatPane } from '@/components/ade/chat-pane';
import { CommandPalette } from '@/components/ade/command-palette';
import {
  type ClientProviderSettings,
  EMPTY_PROVIDER_SETTINGS,
  SettingsDialog,
} from '@/components/ade/settings-dialog';
import { Sidebar, type SidebarChatItem } from '@/components/ade/sidebar';
import { TopBar } from '@/components/ade/top-bar';
import { VoiceModal } from '@/components/ade/voice-modal';
import type { GenUiActionHandler } from '@/components/genui/registry';
import type { InlineAiEditRequest } from '@/components/workbench/files-editor-pane';
import type { PromotedGenUiSpec } from '@/components/workbench/genui-canvas-pane';
import { WorkbenchPane } from '@/components/workbench/workbench-pane';
import {
  DEFAULT_SPONSORED_MODEL_ID,
  isSponsoredModelId,
  MODEL_CATALOG,
  REALTIME_MODEL_ID,
  resolveSponsoredModelId,
} from '@/lib/ai/models';
import type { ProviderDiagnostics } from '@/lib/ai/provider';
import {
  readStoredAstryxPalette,
  readStoredThemeMode,
  setAstryxPalette,
  setThemeMode,
} from '@/lib/theme/astryx-tokens';
import type {
  ArtifactKind,
  ArtifactRecord,
  AstryxPalette,
  BillingSourceInfo,
  BrowserControlState,
  BrowserStreamMode,
  HarnessMode,
  ModelDefinition,
  SandboxTier,
  ThemeMode,
  TokenUsageSummary,
  TraceSpan,
  WorkbenchTab,
  WorkspaceFileEntry,
} from '@/lib/types';
import { useUiAgent } from '@/lib/ui-agent/bridge';
import { cn, generateId } from '@/lib/utils';

const PROVIDER_SETTINGS_STORAGE_KEY = 'minimal-ade:provider-settings';

export interface AdeShellSessionUser {
  userId: string;
  name?: string;
  email?: string;
  image?: string;
  isGuest: boolean;
}

export interface AdeShellProps {
  chatId: string;
  isNewChat?: boolean;
  initialTitle?: string;
  initialModelId?: string;
  initialHarnessMode?: HarnessMode;
  initialMessages?: AdeUIMessage[];
  initialVotes?: Record<string, boolean>;
  initialChats?: SidebarChatItem[];
  initialArtifacts?: ArtifactRecord[];
  initialWorkspaceFiles?: WorkspaceFileEntry[];
  initialWorkspaceFileMap?: Record<string, string>;
  initialDiagnostics?: ProviderDiagnostics | null;
  models?: ModelDefinition[];
  sessionUser?: AdeShellSessionUser | null;
}

function readStoredProviderSettings(): ClientProviderSettings {
  if (typeof window === 'undefined') return EMPTY_PROVIDER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(PROVIDER_SETTINGS_STORAGE_KEY);
    if (!raw) return EMPTY_PROVIDER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ClientProviderSettings>;
    return {
      ...EMPTY_PROVIDER_SETTINGS,
      ...parsed,
    };
  } catch {
    return EMPTY_PROVIDER_SETTINGS;
  }
}

export function AdeShell({
  chatId,
  isNewChat = false,
  initialTitle = 'New Chat',
  initialModelId,
  initialHarnessMode = 'ai-sdk',
  initialMessages = [],
  initialVotes = {},
  initialChats = [],
  initialArtifacts = [],
  initialWorkspaceFiles = [],
  initialWorkspaceFileMap = {},
  initialDiagnostics = null,
  models = [...MODEL_CATALOG],
  sessionUser = null,
}: AdeShellProps) {
  const router = useRouter();
  const { registerController, runDemo } = useUiAgent();

  // Shell layout & progressive-disclosure Workbench state
  const initialHasArtifacts = initialArtifacts.length > 0;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workbenchOpen, setWorkbenchOpen] = useState(initialHasArtifacts);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>(
    initialArtifacts[0]?.kind === 'html'
      ? 'preview'
      : initialArtifacts[0]?.kind === 'genui'
        ? 'genui'
        : 'files',
  );

  // Overlays & modals
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'harnesses' | 'appearance'>(
    'providers',
  );
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);

  // Appearance (Astryx light-dark + 4 palettes)
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [palette, setPalette] = useState<AstryxPalette>('neutral');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  // Chat & Runtime state
  const [chats, setChats] = useState<SidebarChatItem[]>(initialChats);
  const [chatTitle, setChatTitle] = useState(initialTitle);
  const [modelId, setModelId] = useState(() => {
    const initial =
      initialModelId || initialDiagnostics?.defaultModelId || DEFAULT_SPONSORED_MODEL_ID;
    const isInitialSponsored =
      initialDiagnostics &&
      !initialDiagnostics.activeBillingInfo.isUserBilled &&
      initialDiagnostics.activeBillingSource !== 'unconfigured';
    if (isInitialSponsored && !isSponsoredModelId(initial)) {
      return resolveSponsoredModelId(initial, {
        openaiOnly: initialDiagnostics.activeBillingSource === 'sponsor-openai',
      }).modelId;
    }
    return initial;
  });
  const [harnessMode, setHarnessMode] = useState<HarnessMode>(initialHarnessMode);
  const [sandboxTier, setSandboxTier] = useState<SandboxTier>('just-bash');
  const [isStreaming, setIsStreaming] = useState(false);

  // Provider diagnostics & client-local overrides
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostics | null>(initialDiagnostics);
  const [billingInfo, setBillingInfo] = useState<BillingSourceInfo>(
    initialDiagnostics?.activeBillingInfo ?? {
      source: 'unconfigured',
      label: 'Resolving provider…',
      providerName: 'Minimal ADE',
      isUserBilled: false,
    },
  );
  const [providerSettings, setProviderSettings] =
    useState<ClientProviderSettings>(EMPTY_PROVIDER_SETTINGS);

  // Workbench data state
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>(initialArtifacts);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(
    initialArtifacts[0]?.id ?? null,
  );
  const [activeWorkspaceFilePath, setActiveWorkspaceFilePath] = useState<string | null>(null);
  const [fileSelectionNonce, setFileSelectionNonce] = useState<number>(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>(initialWorkspaceFiles);
  const [workspaceFileMap, setWorkspaceFileMap] =
    useState<Record<string, string>>(initialWorkspaceFileMap);
  const [previewHtmlSrcDoc, setPreviewHtmlSrcDoc] = useState<string | null>(() => {
    const htmlArt = initialArtifacts.find((a) => a.kind === 'html');
    return htmlArt?.content ?? initialWorkspaceFileMap['index.html'] ?? null;
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [browserMode, setBrowserMode] = useState<BrowserStreamMode>('preview');
  const [browserUrl, setBrowserUrl] = useState<string>('workspace://index.html');
  const [browserHumanControl, setBrowserHumanControl] = useState(false);
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);
  const [queuedTerminalCommand, setQueuedTerminalCommand] = useState<{
    id: string;
    command: string;
  } | null>(null);

  // Promoted GenUI specs + Trace waterfall + Token usage
  const [genUiSpecs, setGenUiSpecs] = useState<PromotedGenUiSpec[]>(() =>
    initialArtifacts
      .filter((a) => a.kind === 'genui' && a.spec)
      .map((a) => ({
        id: a.id,
        title: a.title,
        spec: a.spec as unknown as Spec,
        createdAt: a.createdAt,
      })),
  );
  const [activeGenUiSpecId, setActiveGenUiSpecId] = useState<string | null>(null);
  const [traceSpans, setTraceSpans] = useState<TraceSpan[]>([]);
  const [traceClearedAt, setTraceClearedAt] = useState<number>(0);
  const [clearedTraceSpanIds, setClearedTraceSpanIds] = useState<Set<string>>(() => new Set());
  const [usage, setUsage] = useState<TokenUsageSummary | null>(null);

  const visibleTraceSpans = useMemo(() => {
    if (traceClearedAt === 0 && clearedTraceSpanIds.size === 0) return traceSpans;
    return traceSpans.filter(
      (s) =>
        !clearedTraceSpanIds.has(s.id) && (s.status === 'running' || s.startedAt >= traceClearedAt),
    );
  }, [traceSpans, traceClearedAt, clearedTraceSpanIds]);

  // External prompts dispatched from Workbench/Voice/GenUI into ChatPane
  const [externalPromptQueue, setExternalPromptQueue] = useState<{
    id: string;
    text: string;
  } | null>(null);

  const hasSyncedUrlRef = useRef(!isNewChat);

  // Resizable split controller (@ui-sdk/react/resizable)
  const resizableController = useMemo(() => createResizableController(), []);
  const prevWorkbenchOpenRef = useRef(workbenchOpen);
  const lastExpandedWorkbenchSizeRef = useRef<number | null>(null);

  const refreshDiagnosticsRef = useRef<
    ((overrideSettings?: ClientProviderSettings) => Promise<void>) | null
  >(null);

  // Hydrate client preferences & local provider settings after mount
  useEffect(() => {
    const storedTheme = readStoredThemeMode();
    const storedPalette = readStoredAstryxPalette();
    setTheme(storedTheme);
    setPalette(storedPalette);

    const computeResolved = (t: ThemeMode): 'light' | 'dark' => {
      if (t === 'dark') return 'dark';
      if (t === 'light') return 'light';
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    };
    setResolvedTheme(computeResolved(storedTheme));

    const storedProvider = readStoredProviderSettings();
    setProviderSettings(storedProvider);

    // Collapse sidebar by default on narrow viewports
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }

    if (storedProvider.customBaseUrl || storedProvider.byokApiKey || storedProvider.githubToken) {
      void refreshDiagnosticsRef.current?.(storedProvider);
    }
  }, []);

  // Sync resolved theme whenever theme changes or OS preference flips
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      setResolvedTheme(theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [theme]);

  // Synchronize Resizable panel width smoothly when workbenchOpen changes
  useEffect(() => {
    const wasOpen = prevWorkbenchOpenRef.current;
    prevWorkbenchOpenRef.current = workbenchOpen;

    // Auto-collapse left sidebar when opening the Workbench on < 1360px viewports
    // (only on false -> true transition so users can still re-open the sidebar anytime)
    if (!wasOpen && workbenchOpen && typeof window !== 'undefined' && window.innerWidth < 1360) {
      setSidebarOpen(false);
    }

    const frame = window.requestAnimationFrame(() => {
      if (workbenchOpen) {
        const remembered = lastExpandedWorkbenchSizeRef.current;
        const targetWorkbench =
          remembered !== null && remembered >= 35 && remembered <= 68 ? remembered : 48;
        const current = resizableController.getLayout();
        if (resizableController.isCollapsed('workbench') || !current[1] || current[1] < 35) {
          resizableController.setLayout([100 - targetWorkbench, targetWorkbench]);
        }
      } else {
        resizableController.collapse('workbench');
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workbenchOpen, resizableController]);

  const refreshDiagnostics = useCallback(
    async (overrideSettings?: ClientProviderSettings) => {
      const cfg = overrideSettings ?? providerSettings;
      try {
        const res = await fetch('/api/provider/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerOverride: {
              ...(cfg.mode !== 'auto' ? { mode: cfg.mode } : {}),
              ...(cfg.customBaseUrl ? { customBaseUrl: cfg.customBaseUrl } : {}),
              ...(cfg.customApiKey ? { customApiKey: cfg.customApiKey } : {}),
              ...(cfg.customModel ? { customModel: cfg.customModel } : {}),
              ...(cfg.byokApiKey ? { byokApiKey: cfg.byokApiKey } : {}),
            },
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          diagnostics?: ProviderDiagnostics;
          activeBillingInfo?: BillingSourceInfo;
        };
        if (data.diagnostics) {
          setDiagnostics(data.diagnostics);
        }
        if (data.activeBillingInfo) {
          setBillingInfo(data.activeBillingInfo);
        } else if (data.diagnostics?.activeBillingInfo) {
          setBillingInfo(data.diagnostics.activeBillingInfo);
        }
      } catch {
        // Keep current diagnostics on offline error
      }
    },
    [providerSettings],
  );
  refreshDiagnosticsRef.current = refreshDiagnostics;

  const handleSaveProviderSettings = useCallback((next: ClientProviderSettings) => {
    setProviderSettings(next);
    try {
      window.localStorage.setItem(PROVIDER_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleThemeChange = useCallback((next: ThemeMode) => {
    setTheme(next);
    setThemeMode(next);
  }, []);

  const handlePaletteChange = useCallback((next: AstryxPalette) => {
    setPalette(next);
    setAstryxPalette(next);
  }, []);

  const handleOpenSettings = useCallback(
    (tab: 'providers' | 'harnesses' | 'appearance' = 'providers') => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    },
    [],
  );

  const isSponsoredMode = !billingInfo.isUserBilled && billingInfo.source !== 'unconfigured';

  useEffect(() => {
    if (!isSponsoredMode) return;
    if (isSponsoredModelId(modelId)) return;
    const clamped = resolveSponsoredModelId(modelId, {
      openaiOnly: billingInfo.source === 'sponsor-openai',
    }).modelId;
    if (clamped !== modelId) {
      setModelId(clamped);
    }
  }, [isSponsoredMode, billingInfo.source, modelId]);

  const handleSelectModel = useCallback(
    (nextModel: string) => {
      if (isSponsoredMode && !isSponsoredModelId(nextModel)) {
        const entry = models.find((m) => m.id === nextModel);
        toast.info(
          `${entry?.name ?? nextModel} requires your own OpenAI or AI Gateway key. Add one in Settings to unlock.`,
        );
        handleOpenSettings('providers');
        return;
      }
      setModelId(nextModel);
    },
    [isSponsoredMode, models, handleOpenSettings],
  );

  const handleOpenWorkbench = useCallback(
    (tab: WorkbenchTab, target?: string) => {
      setWorkbenchOpen(true);
      setActiveTab(tab);
      if (tab === 'browser' && target && /^https?:\/\//i.test(target)) {
        setBrowserUrl(target);
        setBrowserRefreshKey((k) => k + 1);
      } else if (tab === 'files' && target) {
        const match = artifacts.find((a) => a.id === target);
        if (match) {
          setActiveArtifactId(match.id);
        } else {
          const cleanPath = target
            .trim()
            .replace(/^\/+/, '')
            .replace(/^workspace\//, '');
          if (cleanPath) {
            setActiveWorkspaceFilePath(cleanPath);
            setFileSelectionNonce((n) => n + 1);
          }
        }
      }
    },
    [artifacts],
  );

  const handleNewChat = useCallback(() => {
    router.push('/');
    router.refresh();
  }, [router]);

  const handleSelectChat = useCallback(
    (id: string) => {
      if (id === chatId) return;
      router.push(`/chat/${encodeURIComponent(id)}`);
    },
    [chatId, router],
  );

  const handleCopyMcpUrl = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/api/mcp`;
    void navigator.clipboard.writeText(url);
    toast.success('Copied Remote MCP endpoint URL', { description: url });
  }, []);

  const dispatchPromptToChat = useCallback((text: string) => {
    setExternalPromptQueue({ id: generateId('ext', 8), text });
  }, []);

  // Refresh workspace files after agent sandbox mutations
  const refreshWorkspaceFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/files?chatId=${encodeURIComponent(chatId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        files?: WorkspaceFileEntry[];
        fileMap?: Record<string, string>;
        status?: { previewUrl?: string };
      };
      if (Array.isArray(data.files)) {
        setWorkspaceFiles(data.files);
      }
      if (data.fileMap && typeof data.fileMap === 'object') {
        setWorkspaceFileMap(data.fileMap);
        if (typeof data.fileMap['index.html'] === 'string') {
          setPreviewHtmlSrcDoc(data.fileMap['index.html']);
          setBrowserRefreshKey((k) => k + 1);
        }
      }
      if (data.status?.previewUrl) {
        setPreviewUrl(data.status.previewUrl);
      }
    } catch {
      // Non-fatal
    }
  }, [chatId]);

  const handleArtifactDetected = useCallback((artifact: ArtifactRecord, autoOpen = true) => {
    setArtifacts((prev) => {
      const idx = prev.findIndex((a) => a.id === artifact.id);
      if (idx === -1) return [artifact, ...prev];
      const copy = [...prev];
      copy[idx] = artifact;
      return copy;
    });
    setActiveArtifactId(artifact.id);

    if (artifact.kind === 'html') {
      setPreviewHtmlSrcDoc(artifact.content);
      if (autoOpen) {
        setWorkbenchOpen(true);
        setActiveTab('preview');
      }
    } else if (artifact.kind === 'genui' && artifact.spec) {
      setGenUiSpecs((prev) => [
        {
          id: artifact.id,
          title: artifact.title,
          spec: artifact.spec as unknown as Spec,
          createdAt: artifact.createdAt,
        },
        ...prev.filter((s) => s.id !== artifact.id),
      ]);
      setActiveGenUiSpecId(artifact.id);
      if (autoOpen) {
        setWorkbenchOpen(true);
        setActiveTab('genui');
      }
    } else if (autoOpen) {
      setWorkbenchOpen(true);
      setActiveTab('files');
    }
  }, []);

  const persistPromotedArtifact = useCallback(
    async (artifact: ArtifactRecord) => {
      try {
        const res = await fetch('/api/artifacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: artifact.id,
            chatId,
            title: artifact.title,
            kind: artifact.kind,
            language: artifact.language ?? null,
            content: artifact.content,
            ...(artifact.spec !== undefined ? { spec: artifact.spec } : {}),
          }),
        });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as { artifact?: ArtifactRecord };
        if (data.artifact) {
          const saved = data.artifact;
          setArtifacts((prev) => {
            const idx = prev.findIndex((a) => a.id === saved.id);
            if (idx === -1) return [saved, ...prev];
            const copy = [...prev];
            copy[idx] = saved;
            return copy;
          });
        }
      } catch {
        // Keep optimistic client artifact gracefully
      }
    },
    [chatId],
  );

  const handlePromoteGenUiSpec = useCallback(
    (spec: Spec, title?: string) => {
      const id = generateId('genui', 8);
      const nowIso = new Date().toISOString();
      const label = title || 'Generative UI Widget';
      const entry: PromotedGenUiSpec = {
        id,
        title: label,
        spec,
        createdAt: nowIso,
      };
      setGenUiSpecs((prev) => [entry, ...prev]);
      setActiveGenUiSpecId(id);
      setWorkbenchOpen(true);
      setActiveTab('genui');
      toast.success('Promoted widget to GenUI Canvas');

      const record: ArtifactRecord = {
        id,
        chatId,
        title: label,
        kind: 'genui',
        content: JSON.stringify(spec, null, 2),
        language: 'json',
        version: 1,
        spec: spec as unknown as Record<string, unknown>,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      void persistPromotedArtifact(record);
    },
    [chatId, persistPromotedArtifact],
  );

  const handleGenUiAction: GenUiActionHandler = useCallback(
    (actionName, params) => {
      if (actionName === 'send_prompt' && typeof params?.prompt === 'string') {
        dispatchPromptToChat(params.prompt);
      } else if (actionName === 'open_workbench' && typeof params?.tab === 'string') {
        handleOpenWorkbench(
          params.tab as WorkbenchTab,
          typeof params.target === 'string' ? params.target : undefined,
        );
      } else if (actionName === 'promote_artifact' && params) {
        const nowIso = new Date().toISOString();
        const art: ArtifactRecord = {
          id: generateId('art', 10),
          chatId,
          title: String(params.title ?? 'Artifact'),
          kind: (params.kind as ArtifactKind) ?? 'code',
          content: String(params.content ?? ''),
          language: typeof params.language === 'string' ? params.language : undefined,
          version: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        handleArtifactDetected(art, true);
        void persistPromotedArtifact(art);
      } else if (actionName === 'run_command' && typeof params?.command === 'string') {
        setWorkbenchOpen(true);
        setActiveTab('terminal');
        setQueuedTerminalCommand({
          id: generateId('cmd', 6),
          command: params.command,
        });
      } else if (actionName === 'submit_form' && params) {
        const title = String(params.title ?? 'Form');
        const values = JSON.stringify(params.values ?? {}, null, 2);
        dispatchPromptToChat(
          `I submitted the "${title}" form with these values:\n\`\`\`json\n${values}\n\`\`\``,
        );
      } else if (actionName === 'approve_action' && params) {
        const approved = Boolean(params.approved);
        dispatchPromptToChat(
          `Action "${String(params.actionId ?? 'action')}" was ${approved ? 'APPROVED' : 'DENIED'}${params.note ? `: ${String(params.note)}` : '.'}`,
        );
      }
    },
    [
      chatId,
      dispatchPromptToChat,
      handleArtifactDetected,
      handleOpenWorkbench,
      persistPromotedArtifact,
    ],
  );

  const handleAskAiEdit = useCallback(
    (req: InlineAiEditRequest) => {
      const targetLabel = req.filePath
        ? `file \`${req.filePath}\``
        : `artifact "${req.artifactTitle ?? req.artifactId}"`;
      const prompt = [
        `Please edit lines ${req.fromLine}–${req.toLine} of ${targetLabel}.`,
        `Instruction: ${req.instruction}`,
        '',
        'Selected snippet:',
        '```',
        req.selectionText,
        '```',
        req.filePath
          ? 'Apply the change directly using write_file.'
          : req.artifactId
            ? `Apply the update directly using update_artifact (id: "${req.artifactId}").`
            : '',
      ]
        .filter(Boolean)
        .join('\n');
      dispatchPromptToChat(prompt);
    },
    [dispatchPromptToChat],
  );

  const handleRenameChat = useCallback(
    async (targetId: string, title: string) => {
      if (targetId === chatId) setChatTitle(title);
      setChats((prev) => prev.map((c) => (c.id === targetId ? { ...c, title } : c)));
      try {
        await fetch(`/api/chats/${encodeURIComponent(targetId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
      } catch {
        // Optimistic update kept
      }
    },
    [chatId],
  );

  const handleDeleteChat = useCallback(
    async (targetId: string) => {
      setChats((prev) => prev.filter((c) => c.id !== targetId));
      try {
        await fetch(`/api/chats/${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
        });
        toast.success('Conversation deleted');
      } catch {
        // ignore
      }
      if (targetId === chatId) {
        router.push('/');
      }
    },
    [chatId, router],
  );

  const handleTogglePinChat = useCallback(async (targetId: string, pinned: boolean) => {
    setChats((prev) => prev.map((c) => (c.id === targetId ? { ...c, pinned } : c)));
    try {
      await fetch(`/api/chats/${encodeURIComponent(targetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
    } catch {
      // ignore
    }
  }, []);

  const handleToggleVisibility = useCallback(
    async (targetId: string, visibility: 'private' | 'public') => {
      setChats((prev) => prev.map((c) => (c.id === targetId ? { ...c, visibility } : c)));
      try {
        await fetch(`/api/chats/${encodeURIComponent(targetId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility }),
        });
      } catch {
        // ignore
      }
    },
    [],
  );

  const handleChatTitleHint = useCallback(
    (firstPrompt: string) => {
      const compact = firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 56);
      if (chatTitle === 'New Chat' && compact) {
        setChatTitle(compact);
      }
      const nowIso = new Date().toISOString();
      setChats((prev) => {
        if (prev.some((c) => c.id === chatId)) return prev;
        return [
          {
            id: chatId,
            title: compact || 'New Chat',
            modelId,
            harnessMode,
            visibility: 'private',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          ...prev,
        ];
      });
      if (!hasSyncedUrlRef.current && typeof window !== 'undefined') {
        hasSyncedUrlRef.current = true;
        window.history.replaceState(null, '', `/chat/${encodeURIComponent(chatId)}`);
      }
    },
    [chatId, chatTitle, harnessMode, modelId],
  );

  // Wire EVERY ADE Shell control into @ui-sdk/react/agent Self-Operating UI Bridge!
  useEffect(() => {
    registerController({
      route: isNewChat ? '/' : `/chat/${chatId}`,
      theme,
      palette,
      modelId,
      harnessMode,
      workbenchOpen,
      activeTab,
      sidebarOpen,
      browserMode,
      browserUrl,
      onSetTheme: handleThemeChange,
      onSetPalette: handlePaletteChange,
      onSetWorkbenchOpen: (open) => setWorkbenchOpen(open),
      onSetWorkbenchTab: (tab) => {
        setWorkbenchOpen(true);
        setActiveTab(tab);
      },
      onSetModel: (nextModel) => handleSelectModel(nextModel),
      onSetHarness: (nextHarness) => setHarnessMode(nextHarness),
      onOpenCommandPalette: () => setCommandPaletteOpen(true),
      onOpenSettings: (tab) =>
        handleOpenSettings(tab === 'harnesses' || tab === 'appearance' ? tab : 'providers'),
      onToggleSidebar: (open) =>
        setSidebarOpen((prev) => (typeof open === 'boolean' ? open : !prev)),
      onBrowserNavigate: (url) => {
        setWorkbenchOpen(true);
        setActiveTab('browser');
        setBrowserUrl(url);
        setBrowserRefreshKey((k) => k + 1);
      },
      onBrowserTakeControl: () => {
        setWorkbenchOpen(true);
        setActiveTab('browser');
        setBrowserHumanControl(true);
      },
      onBrowserReleaseControl: () => {
        setBrowserHumanControl(false);
      },
      onTerminalRun: (command) => {
        setWorkbenchOpen(true);
        setActiveTab('terminal');
        setQueuedTerminalCommand({ id: generateId('cmd', 6), command });
      },
      onNewChat: handleNewChat,
    });
  }, [
    registerController,
    isNewChat,
    chatId,
    theme,
    palette,
    modelId,
    harnessMode,
    workbenchOpen,
    activeTab,
    sidebarOpen,
    browserMode,
    browserUrl,
    handleThemeChange,
    handlePaletteChange,
    handleOpenSettings,
    handleSelectModel,
    handleNewChat,
  ]);

  // Global keyboard shortcuts: ⌘K, ⌘., ⌘J, ⌘Shift+O
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
      } else if (e.key === '.' && !e.shiftKey) {
        e.preventDefault();
        setWorkbenchOpen((v) => !v);
      } else if (key === 'j' && !e.shiftKey) {
        e.preventDefault();
        setWorkbenchOpen((open) => {
          if (open && activeTab === 'terminal') return false;
          setActiveTab('terminal');
          return true;
        });
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, handleNewChat]);

  const handleBrowserStateChange = useCallback((state: BrowserControlState) => {
    setBrowserMode(state.mode);
    if (state.url) setBrowserUrl(state.url);
    setBrowserHumanControl(state.isHumanInControl);
    if (state.previewUrl) setPreviewUrl(state.previewUrl);
  }, []);

  const workbenchBadgeCount =
    artifacts.length + genUiSpecs.length + (traceSpans.length > 0 ? 1 : 0);

  return (
    <div
      id="main-content"
      className="flex h-[100dvh] w-full overflow-hidden bg-[var(--bg-canvas)] text-[var(--fg-primary)]"
    >
      {/* Left Collapsible Sidebar */}
      <Sidebar
        open={sidebarOpen}
        chats={chats}
        activeChatId={chatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onRenameChat={handleRenameChat}
        onDeleteChat={handleDeleteChat}
        onTogglePinChat={handleTogglePinChat}
        onToggleVisibility={handleToggleVisibility}
        onCloseSidebar={() => setSidebarOpen(false)}
        onOpenSettings={() => handleOpenSettings('providers')}
        onCopyMcpUrl={handleCopyMcpUrl}
        sessionUser={sessionUser}
        vercelOAuthConfigured={Boolean(
          diagnostics?.vercelOAuthConfigured || diagnostics?.vercelConnectConfigured,
        )}
      />

      {/* Main Column: TopBar + @ui-sdk/react/resizable (Chat ↔ Workbench) */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          chatTitle={chatTitle}
          onRenameTitle={(nextTitle) => void handleRenameChat(chatId, nextTitle)}
          harnessMode={harnessMode}
          onChangeHarness={setHarnessMode}
          billingInfo={billingInfo}
          onOpenSettings={handleOpenSettings}
          theme={theme}
          onChangeTheme={handleThemeChange}
          palette={palette}
          onChangePalette={handlePaletteChange}
          workbenchOpen={workbenchOpen}
          onToggleWorkbench={() => setWorkbenchOpen((v) => !v)}
          workbenchBadgeCount={workbenchBadgeCount}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />

        <Resizable
          orientation="horizontal"
          controller={resizableController}
          defaultLayout={initialHasArtifacts ? [52, 48] : [100, 0]}
          onLayoutCommit={(layout) => {
            if (workbenchOpen && layout[1] !== undefined) {
              if (layout[1] < 4) {
                setWorkbenchOpen(false);
              } else if (layout[1] >= 35) {
                lastExpandedWorkbenchSizeRef.current = layout[1];
              }
            }
          }}
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          {/* Stable Chat Panel (never unmounts when Workbench opens/closes!) */}
          <ResizablePanel
            id="chat"
            defaultSize={initialHasArtifacts ? 52 : 100}
            minSize={32}
            className="flex min-w-0 flex-col overflow-hidden max-md:!basis-full max-md:!flex-1"
          >
            <ChatPane
              chatId={chatId}
              initialMessages={initialMessages}
              initialVotes={initialVotes}
              models={models}
              modelId={modelId}
              onChangeModel={handleSelectModel}
              harnessMode={harnessMode}
              onChangeHarness={setHarnessMode}
              sandboxTier={sandboxTier}
              billingInfo={billingInfo}
              providerSettings={providerSettings}
              workspaceFiles={workspaceFiles}
              externalPromptQueue={externalPromptQueue}
              onConsumeExternalPrompt={(id) =>
                setExternalPromptQueue((cur) => (cur?.id === id ? null : cur))
              }
              onOpenSettings={handleOpenSettings}
              onOpenRealtimeVoice={() => setVoiceModalOpen(true)}
              onOpenWorkbench={handleOpenWorkbench}
              onArtifactDetected={handleArtifactDetected}
              onBrowserToolActivity={(info) => {
                if (info.url) setBrowserUrl(info.url);
                setBrowserRefreshKey((k) => k + 1);
                setWorkbenchOpen(true);
                setActiveTab('browser');
              }}
              onWorkspaceMutated={() => void refreshWorkspaceFiles()}
              onPromoteGenUiSpec={handlePromoteGenUiSpec}
              onGenUiAction={handleGenUiAction}
              onTraceSpansChange={setTraceSpans}
              usage={usage}
              onUsageChange={setUsage}
              onStreamingChange={setIsStreaming}
              onBillingMetadataUpdate={(partial) =>
                setBillingInfo((prev) => ({
                  ...prev,
                  ...(partial.source ? { source: partial.source } : {}),
                  ...(partial.label ? { label: partial.label } : {}),
                }))
              }
              onChatTitleHint={handleChatTitleHint}
              onNewChat={handleNewChat}
            />
          </ResizablePanel>

          {/* Resizable Split Handle */}
          <ResizableHandle
            disabled={!workbenchOpen}
            aria-label="Resize chat and Workbench panes"
            className={cn(
              'group relative z-10 w-1 shrink-0 cursor-col-resize bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)]/60 data-[dragging]:bg-[var(--accent)]',
              workbenchOpen ? 'hidden md:block' : 'hidden',
            )}
          />

          {/* Collapsible Progressive-Disclosure Workbench Panel (full-screen sheet on < md) */}
          <ResizablePanel
            id="workbench"
            collapsible
            collapsedSize={0}
            defaultSize={initialHasArtifacts ? 48 : 0}
            minSize={35}
            maxSize={68}
            className={cn(
              'min-w-0 flex-col overflow-hidden',
              workbenchOpen
                ? 'fixed inset-0 z-30 flex bg-[var(--bg-surface)] md:static md:z-auto md:min-w-[420px]'
                : 'hidden pointer-events-none',
            )}
          >
            {workbenchOpen && (
              <WorkbenchPane
                chatId={chatId}
                activeTab={activeTab}
                onSelectTab={setActiveTab}
                onClose={() => setWorkbenchOpen(false)}
                browserMode={browserMode}
                browserUrl={browserUrl}
                previewHtmlSrcDoc={previewHtmlSrcDoc}
                previewUrl={previewUrl}
                browserRefreshKey={browserRefreshKey}
                isHumanInControl={browserHumanControl}
                onBrowserStateChange={handleBrowserStateChange}
                onSendPrompt={dispatchPromptToChat}
                sandboxTier={sandboxTier}
                onChangeSandboxTier={setSandboxTier}
                workspaceFileMap={workspaceFileMap}
                queuedTerminalCommand={queuedTerminalCommand}
                onQueuedCommandConsumed={(id) =>
                  setQueuedTerminalCommand((cur) => (cur?.id === id ? null : cur))
                }
                artifacts={artifacts}
                activeArtifactId={activeArtifactId}
                onSelectArtifact={setActiveArtifactId}
                onUpdateArtifact={(updated) => {
                  setArtifacts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
                  if (updated.kind === 'html') {
                    setPreviewHtmlSrcDoc(updated.content);
                    setBrowserRefreshKey((k) => k + 1);
                  }
                }}
                workspaceFiles={workspaceFiles}
                selectedFilePath={activeWorkspaceFilePath}
                fileSelectionNonce={fileSelectionNonce}
                onSelectFilePath={setActiveWorkspaceFilePath}
                onWorkspaceFilesChange={setWorkspaceFiles}
                onAskAiEdit={handleAskAiEdit}
                onOpenHtmlInPreview={(htmlContent) => {
                  setPreviewHtmlSrcDoc(htmlContent);
                  setBrowserRefreshKey((k) => k + 1);
                  setActiveTab('preview');
                }}
                resolvedTheme={resolvedTheme}
                genUiSpecs={genUiSpecs}
                activeGenUiSpecId={activeGenUiSpecId}
                onSelectGenUiSpec={setActiveGenUiSpecId}
                onRemoveGenUiSpec={(id) => setGenUiSpecs((prev) => prev.filter((s) => s.id !== id))}
                onGenUiAction={handleGenUiAction}
                traceSpans={visibleTraceSpans}
                usage={usage}
                modelId={modelId}
                harnessMode={harnessMode}
                billingInfo={billingInfo}
                isStreaming={isStreaming}
                onClearTraces={() => {
                  setTraceClearedAt(Date.now());
                  setClearedTraceSpanIds((prev) => {
                    const next = new Set(prev);
                    for (const span of traceSpans) next.add(span.id);
                    return next;
                  });
                }}
              />
            )}
          </ResizablePanel>
        </Resizable>
      </div>

      {/* Global Command Palette (⌘K via @ui-sdk/react/command) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        chats={chats}
        activeChatId={chatId}
        models={models}
        activeModelId={modelId}
        isUserBilled={billingInfo.isUserBilled}
        activeHarness={harnessMode}
        workbenchOpen={workbenchOpen}
        activeWorkbenchTab={activeTab}
        theme={theme}
        palette={palette}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onSelectModel={handleSelectModel}
        onSelectHarness={setHarnessMode}
        onToggleWorkbench={(open) =>
          setWorkbenchOpen((prev) => (typeof open === 'boolean' ? open : !prev))
        }
        onSelectWorkbenchTab={(tab) => {
          setWorkbenchOpen(true);
          setActiveTab(tab);
        }}
        onSetTheme={handleThemeChange}
        onSetPalette={handlePaletteChange}
        onOpenSettings={() => handleOpenSettings('providers')}
        onOpenVoice={() => setVoiceModalOpen(true)}
        onTestUiBridge={() => void runDemo()}
        onCopyMcpUrl={handleCopyMcpUrl}
      />

      {/* Settings & 5-Tier Provider Waterfall Dialog */}
      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
        diagnostics={diagnostics}
        providerSettings={providerSettings}
        onSaveProviderSettings={handleSaveProviderSettings}
        onRefreshDiagnostics={refreshDiagnostics}
        harnessMode={harnessMode}
        onChangeHarnessMode={setHarnessMode}
        sandboxTier={sandboxTier}
        onChangeSandboxTier={setSandboxTier}
        theme={theme}
        onChangeTheme={handleThemeChange}
        palette={palette}
        onChangePalette={handlePaletteChange}
        sessionUser={sessionUser}
      />

      {/* Live Realtime Voice Modal */}
      <VoiceModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        onSendTranscript={dispatchPromptToChat}
        modelId={REALTIME_MODEL_ID}
        providerSettings={providerSettings}
      />
    </div>
  );
}
