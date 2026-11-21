'use client';

import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Code2,
  ExternalLink,
  Eye,
  Globe,
  Hand,
  Layers,
  Link2,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
  Sparkles,
  Tablet,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentBrowserCanvas } from '@/components/workbench/agent-browser-canvas';
import { ScreenRelayViewer } from '@/components/workbench/screen-relay-viewer';
import type {
  BrowserActionResult,
  BrowserSnapshotInput,
  BrowserSnapshotLink,
  BrowserStatusPayload,
} from '@/lib/sandbox/browser-service';
import type { BrowserControlState, BrowserStreamMode, BrowserViewport } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface BrowserPaneProps {
  chatId?: string;
  mode?: BrowserStreamMode;
  url?: string;
  htmlSrcDoc?: string | null;
  previewUrl?: string | null;
  isHumanInControl?: boolean;
  onStateChange?: (state: BrowserControlState) => void;
  onSendPrompt?: (prompt: string) => void;
  refreshKey?: number | string;
  className?: string;
}

type ViewportPreset = 'desktop' | 'tablet' | 'mobile';
type SnapshotSubTab = 'visual' | 'tree' | 'screenshot';

const VIEWPORT_PRESETS: Record<
  ViewportPreset,
  { label: string; viewport: BrowserViewport; maxWidthClass: string }
> = {
  desktop: {
    label: 'Desktop',
    viewport: { width: 1280, height: 800 },
    maxWidthClass: 'w-full',
  },
  tablet: {
    label: 'Tablet',
    viewport: { width: 768, height: 1024 },
    maxWidthClass: 'w-[768px] max-w-full',
  },
  mobile: {
    label: 'Mobile',
    viewport: { width: 390, height: 844 },
    maxWidthClass: 'w-[390px] max-w-full',
  },
};

const MODE_OPTIONS: Array<{ id: BrowserStreamMode; label: string; shortLabel: string }> = [
  { id: 'preview', label: 'Preview', shortLabel: 'Preview' },
  { id: 'screen-relay', label: 'Screen Relay', shortLabel: 'Relay' },
  { id: 'agent-browser', label: 'Agent Browser', shortLabel: 'Browser' },
  { id: 'snapshot', label: 'Snapshot', shortLabel: 'Snapshot' },
];

const QUICK_BOOKMARKS = [
  { label: 'Workspace Preview', url: 'workspace://index.html' },
  { label: 'example.com', url: 'https://example.com' },
  { label: 'Hacker News', url: 'https://news.ycombinator.com' },
];

export function BrowserPane({
  chatId = 'default',
  mode: controlledMode,
  url: controlledUrl,
  htmlSrcDoc,
  previewUrl: controlledPreviewUrl,
  isHumanInControl: controlledHumanControl,
  onStateChange,
  onSendPrompt,
  refreshKey,
  className,
}: BrowserPaneProps) {
  const [activeMode, setActiveMode] = useState<BrowserStreamMode>(controlledMode ?? 'preview');
  const [urlInput, setUrlInput] = useState<string>(controlledUrl ?? 'workspace://index.html');
  const [currentUrl, setCurrentUrl] = useState<string>(controlledUrl ?? 'workspace://index.html');
  const [pageTitle, setPageTitle] = useState<string>('Web ADE · Live Workspace Preview');
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>('desktop');
  const [hasControl, setHasControl] = useState<boolean>(controlledHumanControl ?? false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [iframeKey, setIframeKey] = useState<number>(0);

  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [canGoForward, setCanGoForward] = useState<boolean>(false);
  const [streamUrl, setStreamUrl] = useState<string | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(
    controlledPreviewUrl ?? undefined,
  );
  const [htmlPreview, setHtmlPreview] = useState<string | undefined>(htmlSrcDoc ?? undefined);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | undefined>(undefined);
  const [snapshotTree, setSnapshotTree] = useState<string | undefined>(undefined);
  const [textSummary, setTextSummary] = useState<string | undefined>(undefined);
  const [links, setLinks] = useState<BrowserSnapshotLink[]>([]);
  const [inputs, setInputs] = useState<BrowserSnapshotInput[]>([]);
  const [backendLabel, setBackendLabel] = useState<string>('workspace-preview');
  const [statusMessage, setStatusMessage] = useState<string>('Ready · Workspace preview active');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState<boolean>(false);
  const [availableModes, setAvailableModes] = useState({
    preview: true,
    screenRelay: false,
    agentBrowser: false,
    snapshot: true,
  });
  const [snapshotSubTab, setSnapshotSubTab] = useState<SnapshotSubTab>('visual');

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  // Sync controlled props when updated from parent (e.g., UI Agent Bridge or Artifact promotion).
  useEffect(() => {
    if (controlledMode) setActiveMode(controlledMode);
  }, [controlledMode]);

  useEffect(() => {
    if (controlledUrl) {
      setUrlInput(controlledUrl);
      setCurrentUrl(controlledUrl);
    }
  }, [controlledUrl]);

  useEffect(() => {
    if (typeof controlledHumanControl === 'boolean') {
      setHasControl(controlledHumanControl);
    }
  }, [controlledHumanControl]);

  useEffect(() => {
    if (controlledPreviewUrl) {
      setPreviewUrl(controlledPreviewUrl);
    }
  }, [controlledPreviewUrl]);

  useEffect(() => {
    if (typeof htmlSrcDoc === 'string') {
      setHtmlPreview(htmlSrcDoc);
    }
  }, [htmlSrcDoc]);

  const emitState = useCallback(
    (overrides?: Partial<BrowserControlState>) => {
      onStateChangeRef.current?.({
        mode: overrides?.mode ?? activeMode,
        url: overrides?.url ?? currentUrl,
        title: overrides?.title ?? pageTitle,
        isConnected:
          overrides?.isConnected ??
          (activeMode === 'preview' || activeMode === 'snapshot' || streamConnected),
        isHumanInControl: overrides?.isHumanInControl ?? hasControl,
        streamUrl: overrides?.streamUrl ?? streamUrl,
        previewUrl: overrides?.previewUrl ?? previewUrl,
        lastScreenshotUrl: overrides?.lastScreenshotUrl ?? screenshotDataUrl,
        viewport: overrides?.viewport ?? VIEWPORT_PRESETS[viewportPreset].viewport,
        statusMessage: overrides?.statusMessage ?? statusMessage,
      });
    },
    [
      activeMode,
      currentUrl,
      hasControl,
      pageTitle,
      previewUrl,
      screenshotDataUrl,
      statusMessage,
      streamConnected,
      streamUrl,
      viewportPreset,
    ],
  );

  const applyActionResult = useCallback((res: BrowserActionResult) => {
    if (!res.ok) {
      setErrorMessage(res.error ?? 'Browser action failed');
    } else {
      setErrorMessage(null);
    }

    if (res.url) {
      setCurrentUrl(res.url);
      setUrlInput(res.url);
    }
    if (res.title) setPageTitle(res.title);
    if (res.backend) setBackendLabel(res.backend);
    if (res.htmlPreview !== undefined) setHtmlPreview(res.htmlPreview);
    if (res.screenshotDataUrl !== undefined) setScreenshotDataUrl(res.screenshotDataUrl);
    if (res.snapshotTree !== undefined) setSnapshotTree(res.snapshotTree);
    if (res.textSummary !== undefined) setTextSummary(res.textSummary);
    if (Array.isArray(res.links)) setLinks(res.links);
    if (Array.isArray(res.inputs)) setInputs(res.inputs);
    if (res.streamUrl) setStreamUrl(res.streamUrl);
    if (res.previewUrl) setPreviewUrl(res.previewUrl);
    if (res.statusMessage) setStatusMessage(res.statusMessage);
    setCanGoBack(Boolean(res.canGoBack));
    setCanGoForward(Boolean(res.canGoForward));
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/sandbox/browser?chatId=${encodeURIComponent(chatId)}`, {
        cache: 'no-store',
      });
      const data = (await response.json()) as { ok: boolean; status?: BrowserStatusPayload };
      if (!data.ok || !data.status) return;
      const st = data.status;
      setAvailableModes(st.availableModes);
      setCanGoBack(st.canGoBack);
      setCanGoForward(st.canGoForward);
      if (st.streamUrl) setStreamUrl(st.streamUrl);
      if (st.previewUrl && !controlledPreviewUrl) setPreviewUrl(st.previewUrl);
      if (st.htmlPreview && !htmlSrcDoc) setHtmlPreview(st.htmlPreview);
      if (st.snapshotTree) setSnapshotTree(st.snapshotTree);
      if (st.textSummary) setTextSummary(st.textSummary);
      if (st.links) setLinks(st.links);
      if (st.inputs) setInputs(st.inputs);
      if (st.lastScreenshotUrl) setScreenshotDataUrl(st.lastScreenshotUrl);
      if (st.title) setPageTitle(st.title);
      if (st.backend) setBackendLabel(st.backend);
      if (st.statusMessage) setStatusMessage(st.statusMessage);
      if (!controlledUrl && st.url) {
        setCurrentUrl(st.url);
        setUrlInput(st.url);
      }
    } catch {
      // Keep existing local state cleanly.
    }
  }, [chatId, controlledPreviewUrl, controlledUrl, htmlSrcDoc]);

  useEffect(() => {
    void refreshKey;
    void fetchStatus();
  }, [fetchStatus, refreshKey]);

  const dispatchBrowserAction = useCallback(
    async (payload: Record<string, unknown>) => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const res = await fetch('/api/sandbox/browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, ...payload }),
        });
        const data = (await res.json()) as BrowserActionResult;
        applyActionResult(data);
        return data;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Browser request failed';
        setErrorMessage(msg);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [applyActionResult, chatId],
  );

  const handleNavigate = useCallback(
    async (targetUrl: string, overrideMode?: BrowserStreamMode) => {
      const cleaned = targetUrl.trim();
      if (!cleaned) return;

      const isWorkspaceUrl = cleaned.startsWith('workspace://');
      const nextMode: BrowserStreamMode =
        overrideMode ??
        (isWorkspaceUrl
          ? 'preview'
          : activeMode === 'preview' &&
              !cleaned.startsWith('http://localhost') &&
              !cleaned.includes('.vercel.run')
            ? 'snapshot'
            : activeMode);

      setActiveMode(nextMode);
      setUrlInput(cleaned);

      const res = await dispatchBrowserAction({
        action: 'open',
        url: cleaned,
        mode: nextMode,
      });

      if (nextMode === 'preview') {
        setIframeKey((k) => k + 1);
      }
      if (res) {
        emitState({ mode: nextMode, url: res.url, title: res.title });
      }
    },
    [activeMode, dispatchBrowserAction, emitState],
  );

  const handleModeChange = useCallback(
    (nextMode: BrowserStreamMode) => {
      setActiveMode(nextMode);
      setErrorMessage(null);
      void fetch('/api/sandbox/browser', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'configure', mode: nextMode }),
      }).catch(() => undefined);
      emitState({ mode: nextMode });
    },
    [chatId, emitState],
  );

  const handleToggleControl = useCallback(() => {
    const next = !hasControl;
    setHasControl(next);
    void fetch('/api/sandbox/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, action: 'configure', isHumanInControl: next }),
    }).catch(() => undefined);
    emitState({ isHumanInControl: next });
  }, [chatId, emitState, hasControl]);

  const handleViewportChange = useCallback(
    (preset: ViewportPreset) => {
      setViewportPreset(preset);
      const viewport = VIEWPORT_PRESETS[preset].viewport;
      void fetch('/api/sandbox/browser', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'configure', viewport }),
      }).catch(() => undefined);
      emitState({ viewport });
    },
    [chatId, emitState],
  );

  const handleReload = useCallback(async () => {
    if (activeMode === 'preview') {
      setIframeKey((k) => k + 1);
      await fetchStatus();
      return;
    }
    await dispatchBrowserAction({ action: 'reload' });
  }, [activeMode, dispatchBrowserAction, fetchStatus]);

  const handleScreenshot = useCallback(async () => {
    const res = await dispatchBrowserAction({ action: 'screenshot' });
    if (res?.screenshotDataUrl) {
      setActiveMode('snapshot');
      setSnapshotSubTab('screenshot');
    }
  }, [dispatchBrowserAction]);

  const handleLinkClick = useCallback(
    async (link: BrowserSnapshotLink) => {
      await dispatchBrowserAction({ action: 'click', target: link.ref });
    },
    [dispatchBrowserAction],
  );

  const handleRelayControlChange = useCallback(
    (next: boolean) => {
      setHasControl(next);
      emitState({ isHumanInControl: next });
    },
    [emitState],
  );

  const handleStreamConnectionChange = useCallback((connected: boolean, text: string) => {
    setStreamConnected(connected);
    setStatusMessage(text);
  }, []);

  const handleStreamUrlChange = useCallback(
    (nextUrl: string) => {
      setCurrentUrl(nextUrl);
      setUrlInput(nextUrl);
      emitState({ url: nextUrl });
    },
    [emitState],
  );

  const handleFallbackToSnapshot = useCallback(() => {
    handleModeChange('snapshot');
  }, [handleModeChange]);

  const effectiveHtml = htmlSrcDoc ?? htmlPreview;
  const effectiveIframeUrl = useMemo(() => {
    // Keep Preview isolated to the Sandbox dev-server (`:3000`) or local preview origins;
    // do not allow external websites visited in Browser/Snapshot mode to hijack Preview.
    const isPreviewOrigin = (candidate: string): boolean => {
      try {
        const parsed = new URL(candidate);
        return (
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname.endsWith('.vercel.run')
        );
      } catch {
        return false;
      }
    };

    if (previewUrl && !htmlSrcDoc) {
      return previewUrl;
    }
    if (isPreviewOrigin(currentUrl)) {
      return currentUrl;
    }
    return null;
  }, [currentUrl, htmlSrcDoc, previewUrl]);

  const isExternalHttpUrl = currentUrl.startsWith('http://') || currentUrl.startsWith('https://');

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface text-foreground',
        className,
      )}
    >
      {/* Row 1: Browser Chrome Navigation Bar */}
      <div className="flex items-center gap-1.5 border-b border-border bg-surface px-2.5 py-2">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={!canGoBack || isLoading}
            onClick={() => void dispatchBrowserAction({ action: 'back' })}
            title="Back"
            aria-label="Go back"
            className="astryx-interactive flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-inner)] text-ink-secondary disabled:opacity-35"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!canGoForward || isLoading}
            onClick={() => void dispatchBrowserAction({ action: 'forward' })}
            title="Forward"
            aria-label="Go forward"
            className="astryx-interactive flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-inner)] text-ink-secondary disabled:opacity-35"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void handleReload()}
            title="Reload"
            aria-label="Reload page"
            className="astryx-interactive flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-inner)] text-ink-secondary disabled:opacity-35"
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Editable URL Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleNavigate(urlInput);
          }}
          className="relative flex min-w-0 flex-1 items-center"
        >
          <Globe className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 shrink-0 text-ink-muted" />
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="workspace://index.html or https://example.com"
            aria-label="Browser URL"
            className="h-7 min-w-0 w-full truncate rounded-[var(--radius-inner)] border border-border bg-surface-subtle pr-7 pl-8 font-mono text-xs text-foreground placeholder:text-ink-muted focus:border-accent focus:outline-none"
          />
          {isExternalHttpUrl && (
            <a
              href={currentUrl}
              target="_blank"
              rel="noreferrer"
              title="Open in new tab"
              className="absolute right-2 text-ink-muted transition hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </form>

        {/* Viewport Preset Toggle */}
        <fieldset
          className="flex shrink-0 items-center rounded-[var(--radius-inner)] border border-border bg-surface-subtle p-0.5"
          aria-label="Viewport size"
        >
          {(
            [
              { id: 'desktop', icon: Monitor, title: 'Desktop (1280×800)' },
              { id: 'tablet', icon: Tablet, title: 'Tablet (768×1024)' },
              { id: 'mobile', icon: Smartphone, title: 'Mobile (390×844)' },
            ] as const
          ).map(({ id, icon: Icon, title }) => (
            <button
              key={id}
              type="button"
              onClick={() => handleViewportChange(id)}
              title={title}
              aria-label={title}
              aria-pressed={viewportPreset === id}
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] transition',
                viewportPreset === id
                  ? 'bg-surface text-foreground shadow-xs'
                  : 'text-ink-muted hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </fieldset>
      </div>

      {/* Row 2: Mode Pills + Take Control / Hand Back Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border bg-surface-subtle/70 px-2.5 py-1.5">
        <div
          className="astryx-scroll-fade-x flex min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-x-auto py-0.5"
          role="tablist"
          aria-label="Browser stream mode"
        >
          {MODE_OPTIONS.map((opt) => {
            const isActive = activeMode === opt.id;
            const isLiveReady =
              (opt.id === 'screen-relay' && availableModes.screenRelay) ||
              (opt.id === 'agent-browser' && availableModes.agentBrowser);
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleModeChange(opt.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-inner)] px-2.5 py-1 text-xs font-medium transition',
                  isActive
                    ? 'bg-surface text-foreground shadow-xs ring-1 ring-border-strong'
                    : 'text-ink-secondary hover:bg-overlay-hover hover:text-foreground',
                )}
              >
                {isLiveReady && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                    aria-hidden="true"
                  />
                )}
                <span className="hidden sm:inline">{opt.label}</span>
                <span className="sm:hidden">{opt.shortLabel}</span>
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleScreenshot()}
            disabled={isLoading}
            title="Capture screenshot"
            className="astryx-interactive inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner)] border border-border bg-surface px-2 text-xs text-ink-secondary hover:text-foreground disabled:opacity-40"
          >
            <Camera className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden md:inline">Capture</span>
          </button>

          {/* Prominent Human Takeover Toggle */}
          <button
            type="button"
            onClick={handleToggleControl}
            aria-pressed={hasControl}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-inner)] px-2.5 text-xs font-semibold transition',
              hasControl
                ? 'bg-accent text-accent-foreground shadow-xs hover:bg-accent-hover'
                : 'border border-border-strong bg-surface text-foreground hover:bg-overlay-hover',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                hasControl ? 'animate-pulse bg-white' : 'bg-success',
              )}
            />
            {hasControl ? (
              <>
                <Hand className="h-3.5 w-3.5 shrink-0" />
                <span>Hand Back to Agent</span>
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5 shrink-0" />
                <span>Take Control</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Viewport Stage */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
        {errorMessage && (
          <div className="flex items-center justify-between gap-2 border-b border-danger/20 bg-danger-soft px-3 py-1.5 text-xs text-danger">
            <span className="truncate">{errorMessage}</span>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="shrink-0 font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* MODE A: Live Preview (iframe / HTML srcDoc) */}
        {activeMode === 'preview' && (
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto p-2">
            <div
              className={cn(
                'flex h-full min-h-[320px] flex-col overflow-hidden rounded-[var(--radius-element)] border border-border bg-white shadow-sm transition-all',
                VIEWPORT_PRESETS[viewportPreset].maxWidthClass,
              )}
            >
              {effectiveIframeUrl ? (
                <iframe
                  key={`${iframeKey}-${effectiveIframeUrl}`}
                  src={effectiveIframeUrl}
                  title={pageTitle}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                  className="h-full w-full flex-1 border-0 bg-white"
                />
              ) : (
                <iframe
                  key={`${iframeKey}-srcdoc`}
                  srcDoc={
                    effectiveHtml ||
                    '<!doctype html><html><body style="font-family:system-ui;padding:32px;color:#475569"><h3>No HTML preview loaded</h3><p>Edit <code>index.html</code> or enter any URL above.</p></body></html>'
                  }
                  title={pageTitle}
                  sandbox="allow-scripts allow-forms allow-modals"
                  className="h-full w-full flex-1 border-0 bg-white"
                />
              )}
            </div>
            <div className="mt-1.5 flex w-full items-center justify-between px-1 text-[11px] text-ink-muted">
              <span className="truncate font-mono">
                {effectiveIframeUrl
                  ? `Live URL · ${effectiveIframeUrl}`
                  : `Workspace srcDoc · ${currentUrl}`}
              </span>
              {isExternalHttpUrl && (
                <button
                  type="button"
                  onClick={() => void handleNavigate(currentUrl, 'snapshot')}
                  className="shrink-0 text-accent hover:underline"
                >
                  Blocked by X-Frame-Options? Open Snapshot
                </button>
              )}
            </div>
          </div>
        )}

        {/* MODE B: Live Desktop H.264 Stream via screen-relay */}
        {activeMode === 'screen-relay' && (
          <ScreenRelayViewer
            chatId={chatId}
            hasControl={hasControl}
            onControlChange={handleRelayControlChange}
            onConnectionChange={handleStreamConnectionChange}
            onFallbackToSnapshot={handleFallbackToSnapshot}
          />
        )}

        {/* MODE C: Live Pair-Browsing JPEG Stream via agent-browser */}
        {activeMode === 'agent-browser' && (
          <AgentBrowserCanvas
            streamUrl={streamUrl}
            hasControl={hasControl}
            viewport={VIEWPORT_PRESETS[viewportPreset].viewport}
            onUrlChange={handleStreamUrlChange}
            onConnectionChange={handleStreamConnectionChange}
            onFallbackToSnapshot={handleFallbackToSnapshot}
          />
        )}

        {/* MODE D: Interactive Snapshot Fallback Viewer */}
        {activeMode === 'snapshot' && (
          <div className="astryx-scroll-shadow flex min-h-0 flex-1 flex-col gap-3 p-3">
            {/* Quick Bookmark Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_BOOKMARKS.map((bm) => (
                  <button
                    key={bm.url}
                    type="button"
                    onClick={() =>
                      void handleNavigate(
                        bm.url,
                        bm.url.startsWith('workspace://') ? 'preview' : 'snapshot',
                      )
                    }
                    className="astryx-interactive rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] font-medium text-ink-secondary hover:text-foreground"
                  >
                    {bm.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1 rounded-[var(--radius-inner)] border border-border bg-surface p-0.5 text-[11px]">
                {(
                  [
                    { id: 'visual', label: 'Summary', icon: Layers },
                    { id: 'tree', label: 'A11y Tree', icon: Code2 },
                    { id: 'screenshot', label: 'Frame', icon: Camera },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSnapshotSubTab(id)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-[6px] px-2 py-0.5 font-medium transition',
                      snapshotSubTab === id
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Active Page Header Card */}
            <div className="rounded-[var(--radius-container)] border border-border bg-surface p-3.5 shadow-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-medium text-accent">
                      {backendLabel}
                    </span>
                    <span className="truncate font-mono text-[11px] text-ink-muted">
                      {currentUrl}
                    </span>
                  </div>
                  <h3 className="mt-1.5 truncate text-sm font-semibold text-foreground">
                    {pageTitle}
                  </h3>
                </div>
                {onSendPrompt && (
                  <button
                    type="button"
                    onClick={() =>
                      onSendPrompt(
                        `Inspect and summarize the current browser page at ${currentUrl} using browser_snapshot.`,
                      )
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-inner)] bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent transition hover:bg-accent hover:text-accent-foreground"
                  >
                    <Sparkles className="h-3 w-3" />
                    Ask Agent
                  </button>
                )}
              </div>

              {snapshotSubTab === 'screenshot' && screenshotDataUrl && (
                <div className="mt-3 overflow-hidden rounded-[var(--radius-element)] border border-border bg-surface-subtle">
                  {/* biome-ignore lint/performance/noImgElement: Dynamic data URL preview from live browser capture */}
                  <img
                    src={screenshotDataUrl}
                    alt={`Screenshot of ${pageTitle}`}
                    className="max-h-[420px] w-full object-contain"
                  />
                </div>
              )}

              {snapshotSubTab === 'tree' && (
                <pre className="mt-3 max-h-[380px] overflow-auto rounded-[var(--radius-element)] border border-border bg-surface-subtle p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {snapshotTree ||
                    'No accessibility snapshot captured yet. Enter a URL above and press Enter.'}
                </pre>
              )}

              {snapshotSubTab === 'visual' && (
                <div className="mt-3 space-y-3">
                  {screenshotDataUrl && (
                    <div className="overflow-hidden rounded-[var(--radius-element)] border border-border bg-surface-subtle">
                      {/* biome-ignore lint/performance/noImgElement: Dynamic data URL preview from live browser capture */}
                      <img
                        src={screenshotDataUrl}
                        alt={`Preview of ${pageTitle}`}
                        className="max-h-56 w-full object-cover object-top"
                      />
                    </div>
                  )}

                  {textSummary ? (
                    <div className="rounded-[var(--radius-element)] border border-border bg-surface-subtle p-3 text-xs leading-relaxed text-ink-secondary">
                      <p className="line-clamp-8 whitespace-pre-wrap">{textSummary}</p>
                    </div>
                  ) : (
                    <div className="rounded-[var(--radius-element)] border border-dashed border-border-strong bg-surface-subtle/60 p-4 text-center text-xs text-ink-muted">
                      Enter any `https://` URL above or click a bookmark pill to fetch a live
                      accessibility snapshot with clickable `@eN` refs.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Interactive Clickable Links (@eN refs) */}
            {links.length > 0 && (
              <div className="rounded-[var(--radius-container)] border border-border bg-surface p-3.5 shadow-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Link2 className="h-3.5 w-3.5 text-accent" />
                    Interactive Links ({links.length})
                  </span>
                  <span className="font-mono text-[10px] text-ink-muted">Click to navigate</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {links.slice(0, 24).map((link) => (
                    <button
                      key={link.ref}
                      type="button"
                      disabled={isLoading}
                      onClick={() => void handleLinkClick(link)}
                      title={link.href}
                      className="astryx-interactive inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-inner)] border border-border bg-surface-subtle px-2 py-1 text-left text-xs text-foreground"
                    >
                      <span className="shrink-0 font-mono text-[10px] font-semibold text-accent">
                        {link.ref}
                      </span>
                      <span className="truncate">{link.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Detected Form Controls */}
            {inputs.length > 0 && (
              <div className="rounded-[var(--radius-container)] border border-border bg-surface p-3.5 shadow-xs">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Terminal className="h-3.5 w-3.5 text-accent" />
                  Detected Inputs ({inputs.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {inputs.slice(0, 12).map((inp) => (
                    <span
                      key={inp.ref}
                      className="inline-flex items-center gap-1.5 rounded-[var(--radius-inner)] border border-border bg-surface-subtle px-2 py-1 font-mono text-[11px] text-ink-secondary"
                    >
                      <span className="font-semibold text-accent">{inp.ref}</span>
                      <span>{inp.placeholder || inp.name || inp.type}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subtle Bottom Status Strip */}
      <div className="flex items-center justify-between border-t border-border bg-surface px-3 py-1 text-[11px] text-ink-muted">
        <span className="truncate">{statusMessage}</span>
        <span className="shrink-0 font-mono text-[10px]">
          {hasControl ? 'HUMAN CONTROL' : 'AGENT MODE'} ·{' '}
          {VIEWPORT_PRESETS[viewportPreset].viewport.width}×
          {VIEWPORT_PRESETS[viewportPreset].viewport.height}
        </span>
      </div>
    </div>
  );
}
