'use client';

import {
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Layers,
  LogOut,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Server,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ProviderDiagnostics } from '@/lib/ai/provider';
import { signInWithVercel, signOut } from '@/lib/auth/auth-client';
import { ASTRYX_PALETTES } from '@/lib/theme/astryx-tokens';
import type {
  AstryxPalette,
  HarnessMode,
  ProviderOverrideMode,
  SandboxTier,
  ThemeMode,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ClientProviderSettings {
  mode: ProviderOverrideMode;
  customBaseUrl: string;
  customApiKey: string;
  customModel: string;
  byokApiKey: string;
  githubToken: string;
}

export const EMPTY_PROVIDER_SETTINGS: ClientProviderSettings = {
  mode: 'auto',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  byokApiKey: '',
  githubToken: '',
};

export interface SettingsDialogProps {
  open: boolean;
  initialTab?: 'providers' | 'harnesses' | 'appearance';
  onOpenChange: (open: boolean) => void;
  diagnostics: ProviderDiagnostics | null;
  providerSettings: ClientProviderSettings;
  onSaveProviderSettings: (next: ClientProviderSettings) => void;
  onRefreshDiagnostics: (override?: ClientProviderSettings) => Promise<void>;
  harnessMode: HarnessMode;
  onChangeHarnessMode: (harness: HarnessMode) => void;
  sandboxTier: SandboxTier;
  onChangeSandboxTier: (tier: SandboxTier) => void;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  palette: AstryxPalette;
  onChangePalette: (palette: AstryxPalette) => void;
  sessionUser?: {
    userId: string;
    name?: string;
    email?: string;
    image?: string;
    isGuest: boolean;
  } | null;
}

export function SettingsDialog({
  open,
  initialTab = 'providers',
  onOpenChange,
  diagnostics,
  providerSettings,
  onSaveProviderSettings,
  onRefreshDiagnostics,
  harnessMode,
  onChangeHarnessMode,
  sandboxTier,
  onChangeSandboxTier,
  theme,
  onChangeTheme,
  palette,
  onChangePalette,
  sessionUser,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [draft, setDraft] = useState<ClientProviderSettings>(providerSettings);
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [showByokKey, setShowByokKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(providerSettings);
      if (initialTab) setActiveTab(initialTab);
    }
  }, [open, providerSettings, initialTab]);

  const mcpUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : '/api/mcp';

  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        'minimal-ade': {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  const normalizeProviderSettings = (raw: ClientProviderSettings): ClientProviderSettings => {
    const customBaseUrl = raw.customBaseUrl.trim();
    const byokApiKey = raw.byokApiKey.trim();
    const inferredMode: ProviderOverrideMode = customBaseUrl
      ? 'custom-openai-compatible'
      : byokApiKey.startsWith('vck_')
        ? 'byok-gateway'
        : byokApiKey
          ? 'byok-openai'
          : 'auto';

    return {
      mode: inferredMode,
      customBaseUrl,
      customApiKey: raw.customApiKey.trim(),
      customModel: raw.customModel.trim(),
      byokApiKey,
      githubToken: raw.githubToken.trim(),
    };
  };

  const handleApplyProviderSettings = async () => {
    const cleaned = normalizeProviderSettings(draft);
    onSaveProviderSettings(cleaned);
    setRefreshing(true);
    try {
      await onRefreshDiagnostics(cleaned);
      toast.success('Provider & credential settings updated (stored locally only)');
    } finally {
      setRefreshing(false);
    }
  };

  const handleClearOverrides = async () => {
    setDraft(EMPTY_PROVIDER_SETTINGS);
    onSaveProviderSettings(EMPTY_PROVIDER_SETTINGS);
    setRefreshing(true);
    try {
      await onRefreshDiagnostics(EMPTY_PROVIDER_SETTINGS);
      toast.success('Cleared local credential overrides');
    } finally {
      setRefreshing(false);
    }
  };

  const handleVercelSignIn = async () => {
    setSigningIn(true);
    try {
      const res = await signInWithVercel(window.location.pathname || '/');
      if (res && typeof res === 'object' && 'error' in res && res.error) {
        const msg =
          typeof res.error === 'object' && res.error !== null && 'message' in res.error
            ? String((res.error as { message?: string }).message ?? '')
            : '';
        toast.error(
          msg ||
            'Sign in with Vercel is not configured on this host (set VERCEL_CLIENT_ID & VERCEL_CLIENT_SECRET).',
        );
        setSigningIn(false);
      }
    } catch {
      toast.error(
        'Sign in with Vercel is not configured on this host (set VERCEL_CLIENT_ID & VERCEL_CLIENT_SECRET).',
      );
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('Signed out');
      window.location.reload();
    } catch {
      toast.error('Could not sign out');
    }
  };

  const handleCopyMcp = async () => {
    await navigator.clipboard.writeText(mcpSnippet);
    setCopiedMcp(true);
    toast.success('Copied MCP server configuration');
    setTimeout(() => setCopiedMcp(false), 1800);
  };

  const byokKind = draft.byokApiKey.trim().startsWith('vck_')
    ? 'Vercel AI Gateway (vck_*)'
    : draft.byokApiKey.trim().startsWith('sk-')
      ? 'OpenAI Direct (sk-*)'
      : draft.byokApiKey.trim()
        ? 'Custom Bearer Key'
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-hidden p-0 flex flex-col">
        <div className="border-b border-[var(--border-subtle)] px-6 pt-5 pb-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-[var(--accent)]" />
              <span>Workspace Settings & Providers</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Configure the 5-tier model & billing waterfall, selectable agent harnesses, sandbox
              execution, and Astryx appearance.
            </DialogDescription>
          </DialogHeader>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(String(val))}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)]/50 px-6 py-2.5">
            <TabsList>
              <TabsTrigger value="providers">
                <KeyRound className="size-3.5" />
                Providers & Billing
              </TabsTrigger>
              <TabsTrigger value="harnesses">
                <Layers className="size-3.5" />
                Harnesses & Sandbox
              </TabsTrigger>
              <TabsTrigger value="appearance">
                <Palette className="size-3.5" />
                Appearance
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* TAB 1: PROVIDERS & BILLING */}
            <TabsContent value="providers" className="space-y-5">
              {/* Live 5-Tier Waterfall Visualizer */}
              <div className="rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)]/55 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-[var(--fg-primary)]">
                      5-Tier Provider & Billing Waterfall
                    </h3>
                    <p className="text-[11px] text-[var(--fg-muted)]">
                      Resolved in strict priority order on every request. Keys are never logged or
                      stored server-side.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={async () => {
                      setRefreshing(true);
                      try {
                        await onRefreshDiagnostics(normalizeProviderSettings(draft));
                      } finally {
                        setRefreshing(false);
                      }
                    }}
                    disabled={refreshing}
                  >
                    <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
                    Refresh
                  </Button>
                </div>

                <div className="space-y-1.5">
                  {(diagnostics?.tiers ?? []).map((tier) => {
                    const tierBadgeLabel =
                      tier.id === 'user-byok'
                        ? '2a'
                        : tier.id === 'user-vercel-oauth'
                          ? '2b'
                          : String(tier.tier);
                    return (
                      <div
                        key={tier.id}
                        className={cn(
                          'flex items-center justify-between gap-3 rounded-[var(--radius-element)] border px-3 py-2 text-xs',
                          tier.active
                            ? 'border-[var(--accent)]/45 bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)]',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={cn(
                              'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold',
                              tier.active
                                ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                                : tier.configured
                                  ? 'bg-[var(--status-success-soft)] text-[var(--status-success)]'
                                  : 'bg-[var(--bg-surface-subtle)] text-[var(--fg-muted)]',
                            )}
                          >
                            {tierBadgeLabel}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-[var(--fg-primary)]">
                              {tier.label}
                            </div>
                            {tier.detail && (
                              <div className="truncate font-mono text-[10.5px] text-[var(--fg-muted)]">
                                {tier.detail}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0">
                          {tier.active ? (
                            <Badge variant="accent">Active</Badge>
                          ) : tier.configured ? (
                            <Badge variant="success">Ready</Badge>
                          ) : (
                            <Badge variant="secondary">Not set</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Tier 1: Custom OpenAI-Compatible Endpoint */}
              <div className="space-y-3 rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="size-4 text-[var(--accent)]" />
                    <h4 className="text-xs font-semibold text-[var(--fg-primary)]">
                      Tier 1 · Custom OpenAI-Compatible Endpoint
                    </h4>
                  </div>
                  <Badge variant="default">Highest Priority</Badge>
                </div>
                <p className="text-[11px] text-[var(--fg-muted)]">
                  Connect Ollama, LM Studio, LiteLLM, vLLM, OpenRouter, or any OpenAI-compatible
                  `/v1` server.
                </p>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <label
                      htmlFor="ade-custom-base-url"
                      className="text-[11px] font-medium text-[var(--fg-secondary)]"
                    >
                      Base URL
                    </label>
                    <Input
                      id="ade-custom-base-url"
                      value={draft.customBaseUrl}
                      onChange={(e) => setDraft((d) => ({ ...d, customBaseUrl: e.target.value }))}
                      placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="ade-custom-api-key"
                      className="text-[11px] font-medium text-[var(--fg-secondary)]"
                    >
                      API Key (optional)
                    </label>
                    <div className="relative">
                      <Input
                        id="ade-custom-api-key"
                        type={showCustomKey ? 'text' : 'password'}
                        value={draft.customApiKey}
                        onChange={(e) => setDraft((d) => ({ ...d, customApiKey: e.target.value }))}
                        placeholder="sk-..."
                        className="h-8 pr-8 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setShowCustomKey((v) => !v)}
                        className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
                        aria-label="Toggle API key visibility"
                      >
                        {showCustomKey ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="ade-custom-model"
                      className="text-[11px] font-medium text-[var(--fg-secondary)]"
                    >
                      Model Override (optional)
                    </label>
                    <Input
                      id="ade-custom-model"
                      value={draft.customModel}
                      onChange={(e) => setDraft((d) => ({ ...d, customModel: e.target.value }))}
                      placeholder="e.g. qwen3-coder:32b"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Tier 2a: BYOK API Key */}
              <div className="space-y-3 rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 text-[var(--accent)]" />
                    <h4 className="text-xs font-semibold text-[var(--fg-primary)]">
                      Tier 2a · Your Own API Key (BYOK)
                    </h4>
                  </div>
                  {byokKind && <Badge variant="accent">{byokKind}</Badge>}
                </div>
                <p className="text-[11px] text-[var(--fg-muted)]">
                  Sponsored mode includes <strong>Claude Haiku 5.5</strong> and{' '}
                  <strong>GPT-6 Luna</strong>. Paste your own Vercel AI Gateway key (
                  <code>vck_*</code>) or OpenAI key (<code>sk-*</code>) to unlock all Anthropic
                  &amp; OpenAI models (Sonnet 5.5, Opus 5.5, GPT-6.2 Sol/Astra, GPT-5.3 Codex).
                </p>
                <div className="relative">
                  <Input
                    type={showByokKey ? 'text' : 'password'}
                    value={draft.byokApiKey}
                    onChange={(e) => setDraft((d) => ({ ...d, byokApiKey: e.target.value }))}
                    placeholder="vck_... or sk-..."
                    className="h-8 pr-8 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowByokKey((v) => !v)}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
                    aria-label="Toggle BYOK key visibility"
                  >
                    {showByokKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>

              {/* Tier 2b: Sign in with Vercel */}
              <div className="space-y-3 rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Cloud className="size-4 text-[var(--accent)]" />
                    <h4 className="text-xs font-semibold text-[var(--fg-primary)]">
                      Tier 2b · Sign in with Vercel (User AI Credits)
                    </h4>
                  </div>
                  {diagnostics?.userCredits?.ok && (
                    <Badge variant="success">
                      {diagnostics.userCredits.balance !== undefined
                        ? `$${diagnostics.userCredits.balance.toFixed(2)} credits`
                        : 'Credits verified'}
                    </Badge>
                  )}
                </div>

                {sessionUser && !sessionUser.isGuest ? (
                  <div className="flex items-center justify-between gap-3 rounded-[var(--radius-element)] bg-[var(--bg-surface-subtle)] px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-[var(--fg-primary)]">
                        {sessionUser.name ?? 'Vercel User'}
                      </div>
                      <div className="truncate text-[11px] text-[var(--fg-muted)]">
                        {sessionUser.email ?? sessionUser.userId}
                      </div>
                    </div>
                    <Button variant="secondary" size="xs" onClick={handleSignOut}>
                      <LogOut className="size-3" />
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-md text-[11px] text-[var(--fg-muted)]">
                      Sign in with Vercel to use your own AI Gateway credits automatically with
                      seamless fallback to host credits on zero balance.
                    </p>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleVercelSignIn()}
                      disabled={signingIn}
                    >
                      <span>▲</span>
                      {signingIn ? 'Redirecting…' : 'Sign in with Vercel'}
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button variant="ghost" size="sm" onClick={() => void handleClearOverrides()}>
                  <Trash2 className="size-3.5" />
                  Clear local overrides
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleApplyProviderSettings()}
                  disabled={refreshing}
                >
                  <CheckCircle2 className="size-3.5" />
                  Save & verify waterfall
                </Button>
              </div>
            </TabsContent>

            {/* TAB 2: HARNESSES & SANDBOX */}
            <TabsContent value="harnesses" className="space-y-5">
              {/* Harness Selector */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-[var(--fg-primary)]">
                  Default Agent Harness
                </h3>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      {
                        id: 'ai-sdk',
                        name: 'AI SDK 7',
                        desc: 'Universal ToolLoopAgent + bash-tool + inline json-render',
                      },
                      {
                        id: 'fx',
                        name: 'fx (libfx)',
                        desc: 'Durable Fluid Compute coding agent with queue wakeHandler',
                      },
                      {
                        id: 'workflow',
                        name: 'Workflow 5',
                        desc: 'Resumable @ai-sdk/workflow multi-step durable execution',
                      },
                    ] as const
                  ).map((item) => {
                    const active = harnessMode === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onChangeHarnessMode(item.id)}
                        className={cn(
                          'flex flex-col items-start rounded-[var(--radius-element)] border p-3 text-left transition-colors cursor-pointer',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--overlay-hover)]',
                        )}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span className="text-xs font-semibold text-[var(--fg-primary)]">
                            {item.name}
                          </span>
                          {active && <Check className="size-3.5 text-[var(--accent)]" />}
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-[var(--fg-muted)]">
                          {item.desc}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Sandbox Execution Tier */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-[var(--fg-primary)]">
                  Sandbox Execution Tier
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      {
                        id: 'just-bash',
                        name: 'Tier 1 · Instant Virtual Bash',
                        desc: 'Zero-cold-start just-bash InMemoryFs + @wterm/just-bash in browser.',
                        icon: Terminal,
                      },
                      {
                        id: 'vercel-sandbox',
                        name: 'Tier 2 · Vercel Sandbox VM',
                        desc: 'Full Ubuntu microVM with preview ports, screen-relay & agent-browser.',
                        icon: Cloud,
                      },
                    ] as const
                  ).map((item) => {
                    const Icon = item.icon;
                    const active = sandboxTier === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onChangeSandboxTier(item.id)}
                        className={cn(
                          'flex items-start gap-2.5 rounded-[var(--radius-element)] border p-3 text-left transition-colors cursor-pointer',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--overlay-hover)]',
                        )}
                      >
                        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-[var(--fg-primary)]">
                              {item.name}
                            </span>
                            {active && <Check className="size-3.5 text-[var(--accent)]" />}
                          </div>
                          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">{item.desc}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* GitHub Tools Token */}
              <div className="space-y-2 rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GitBranch className="size-4 text-[var(--accent)]" />
                    <h4 className="text-xs font-semibold text-[var(--fg-primary)]">
                      GitHub Tools PAT (@github-tools/sdk)
                    </h4>
                  </div>
                  <Badge variant="default">Optional</Badge>
                </div>
                <p className="text-[11px] text-[var(--fg-muted)]">
                  Provide a personal access token to unlock repository exploration, code review, and
                  PR authoring tools directly from chat.
                </p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showGithubToken ? 'text' : 'password'}
                      value={draft.githubToken}
                      onChange={(e) => setDraft((d) => ({ ...d, githubToken: e.target.value }))}
                      placeholder="ghp_... or github_pat_..."
                      className="h-8 pr-8 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGithubToken((v) => !v)}
                      className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
                      aria-label="Toggle GitHub token visibility"
                    >
                      {showGithubToken ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleApplyProviderSettings()}
                  >
                    Save
                  </Button>
                </div>
              </div>

              {/* Remote MCP Server Endpoint */}
              <div className="space-y-2 rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--fg-primary)]">
                      Remote MCP Server Endpoint
                    </h4>
                    <p className="text-[11px] text-[var(--fg-muted)]">
                      Connect Claude Code, Cursor, or <code>fx</code> to this ADE workspace via
                      Streamable HTTP MCP.
                    </p>
                  </div>
                  <Button variant="secondary" size="xs" onClick={() => void handleCopyMcp()}>
                    {copiedMcp ? (
                      <Check className="size-3 text-[var(--status-success)]" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                    Copy config
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] p-3 font-mono text-[11px] text-[var(--fg-primary)]">
                  {mcpSnippet}
                </pre>
              </div>
            </TabsContent>

            {/* TAB 3: APPEARANCE */}
            <TabsContent value="appearance" className="space-y-5">
              {/* Light / Dark / System */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-[var(--fg-primary)]">Color Scheme</h3>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['light', 'Light', Sun],
                      ['dark', 'Dark', Moon],
                      ['system', 'System', Monitor],
                    ] as const
                  ).map(([mode, label, Icon]) => {
                    const active = theme === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => onChangeTheme(mode)}
                        className={cn(
                          'flex items-center justify-center gap-2 rounded-[var(--radius-element)] border px-3 py-2.5 text-xs font-medium transition-colors cursor-pointer',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--fg-secondary)] hover:bg-[var(--overlay-hover)]',
                        )}
                      >
                        <Icon className="size-4" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 4 Astryx Palettes */}
              <div className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--fg-primary)]">Astryx Palette</h3>
                  <p className="text-[11px] text-[var(--fg-muted)]">
                    Zero-rerender CSS <code>light-dark()</code> semantic tokens with WCAG AA
                    contrast.
                  </p>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {ASTRYX_PALETTES.map((item) => {
                    const active = palette === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onChangePalette(item.id)}
                        className={cn(
                          'flex flex-col gap-2 rounded-[var(--radius-container)] border p-3.5 text-left transition-colors cursor-pointer',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--overlay-hover)]',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-[var(--fg-primary)]">
                            {item.name}
                          </span>
                          <div className="flex items-center gap-1">
                            <span
                              className="size-3.5 rounded-full border border-black/15"
                              style={{ background: item.swatches.lightCanvas }}
                            />
                            <span
                              className="size-3.5 rounded-full border border-black/15"
                              style={{ background: item.swatches.lightAccent }}
                            />
                            <span
                              className="size-3.5 rounded-full border border-white/15"
                              style={{ background: item.swatches.darkCanvas }}
                            />
                            <span
                              className="size-3.5 rounded-full border border-white/15"
                              style={{ background: item.swatches.darkAccent }}
                            />
                          </div>
                        </div>
                        <p className="text-[11px] leading-snug text-[var(--fg-muted)]">
                          {item.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
