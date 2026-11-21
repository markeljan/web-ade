'use client';

// @ts-expect-error -- @wterm/react/css exports package stylesheet without a .d.ts file
import '@wterm/react/css';
import { BashShell } from '@wterm/just-bash';
import { Terminal, type TerminalHandle, type WTerm } from '@wterm/react';
import { Cloud, Cpu, ExternalLink, FolderSync, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxStatusInfo } from '@/lib/sandbox/manager';
import type { SandboxTier, WorkbenchTab, WorkspaceFileEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface TerminalPaneProps {
  chatId?: string;
  tier?: SandboxTier;
  files?: Record<string, string>;
  queuedCommand?: { id: string; command: string } | null;
  onQueuedCommandConsumed?: (id: string) => void;
  onFilesChanged?: (files: WorkspaceFileEntry[]) => void;
  onTierChange?: (tier: SandboxTier) => void;
  onOpenTab?: (tab: WorkbenchTab) => void;
  className?: string;
}

type TerminalMode = 'just-bash' | 'vercel-sandbox';

const WORKSPACE_PREFIX = '/workspace';

function buildWorkspaceMapForBash(record: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [relPath, content] of Object.entries(record)) {
    const clean = relPath.replace(/^\/+/, '').replace(/^workspace\//, '');
    if (clean) {
      mapped[`${WORKSPACE_PREFIX}/${clean}`] = content;
    }
  }
  return mapped;
}

function formatCloudPrompt(cwd: string): string {
  const shortCwd = cwd.replace(/^\/vercel\/sandbox/, '~/workspace') || '/';
  return `\x1b[1;36mcloud@sandbox\x1b[0m:\x1b[1;34m${shortCwd}\x1b[0m$ `;
}

export function TerminalPane({
  chatId = 'default',
  tier: controlledTier,
  files: externalFiles,
  queuedCommand,
  onQueuedCommandConsumed,
  onFilesChanged,
  onTierChange,
  onOpenTab,
  className,
}: TerminalPaneProps) {
  const termRef = useRef<TerminalHandle | null>(null);
  const wtermRef = useRef<WTerm | null>(null);
  const shellRef = useRef<BashShell | null>(null);
  const modeRef = useRef<TerminalMode>(
    controlledTier === 'vercel-sandbox' ? 'vercel-sandbox' : 'just-bash',
  );
  const cloudLineRef = useRef<string>('');
  const cloudCwdRef = useRef<string>('/vercel/sandbox');
  const cloudHistoryRef = useRef<string[]>([]);
  const cloudHistoryIdxRef = useRef<number>(-1);
  const cloudBusyRef = useRef<boolean>(false);
  const lastQueuedIdRef = useRef<string | null>(null);

  const [mounted, setMounted] = useState<boolean>(false);
  const [mode, setMode] = useState<TerminalMode>(
    controlledTier === 'vercel-sandbox' ? 'vercel-sandbox' : 'just-bash',
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isUpgrading, setIsUpgrading] = useState<boolean>(false);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(null);
  const [statusNotice, setStatusNotice] = useState<string>('Instant WASM bash ready · /workspace');
  const [workspaceFiles, setWorkspaceFiles] = useState<Record<string, string>>(externalFiles ?? {});
  const workspaceFilesRef = useRef<Record<string, string>>(externalFiles ?? {});
  const [shellReadyNonce, setShellReadyNonce] = useState<number>(0);
  const [shellAttachedNonce, setShellAttachedNonce] = useState<number>(0);
  const onQueuedCommandConsumedRef = useRef(onQueuedCommandConsumed);

  useEffect(() => {
    onQueuedCommandConsumedRef.current = onQueuedCommandConsumed;
  }, [onQueuedCommandConsumed]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (controlledTier === 'vercel-sandbox' || controlledTier === 'just-bash') {
      setMode(controlledTier);
    }
  }, [controlledTier]);

  useEffect(() => {
    if (externalFiles) {
      workspaceFilesRef.current = externalFiles;
      setWorkspaceFiles(externalFiles);
    }
  }, [externalFiles]);

  const writeTerm = useCallback((text: string) => {
    termRef.current?.write(text);
  }, []);

  const fetchWorkspaceFiles = useCallback(async (): Promise<Record<string, string>> => {
    try {
      const res = await fetch(`/api/sandbox/files?chatId=${encodeURIComponent(chatId)}`, {
        cache: 'no-store',
      });
      const data = (await res.json()) as {
        ok: boolean;
        fileMap?: Record<string, string>;
        status?: SandboxStatusInfo;
      };
      if (data.status) setSandboxStatus(data.status);
      if (data.ok && data.fileMap) {
        workspaceFilesRef.current = data.fileMap;
        setWorkspaceFiles(data.fileMap);
        return data.fileMap;
      }
    } catch {
      // Keep current in-memory workspace files.
    }
    return workspaceFilesRef.current;
  }, [chatId]);

  // Attach in-browser @wterm/just-bash shell when terminal is ready & in Tier 1 mode.
  const attachLocalBash = useCallback(async (fileMap: Record<string, string>) => {
    if (!termRef.current) return;
    const mapped = buildWorkspaceMapForBash(fileMap);
    const shell = new BashShell({
      files: mapped,
      cwd: WORKSPACE_PREFIX,
      env: {
        HOME: WORKSPACE_PREFIX,
        PWD: WORKSPACE_PREFIX,
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
      },
      greeting: [
        '\x1b[1;34mWeb ADE\x1b[0m · \x1b[32mInstant Bash (WASM)\x1b[0m  (\x1b[90m@wterm/react + @wterm/just-bash\x1b[0m)',
        '\x1b[90mType `ls`, `cat README.md`, or switch to Cloud Sandbox for a full Linux VM.\x1b[0m',
      ],
      prompt: (cwd) => {
        const short = cwd.replace(/^\/workspace/, '~/workspace') || '/';
        return `\x1b[1;32made\x1b[0m:\x1b[1;34m${short}\x1b[0m$ `;
      },
    });
    shellRef.current = shell;
    termRef.current.write('\x1b[2J\x1b[H');
    await shell.attach((data) => {
      termRef.current?.write(data);
    });
    setStatusNotice(`Instant Bash ready · ${Object.keys(fileMap).length} workspace files`);
  }, []);

  // Execute a command against /api/sandbox/exec (Cloud Sandbox VM mode).
  const runCloudCommand = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed) {
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
        return;
      }

      if (trimmed === 'clear') {
        writeTerm('\x1b[2J\x1b[H');
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
        return;
      }

      cloudHistoryRef.current.push(trimmed);
      cloudHistoryIdxRef.current = -1;
      cloudBusyRef.current = true;
      setStatusNotice(`Running in Cloud Sandbox: ${trimmed.slice(0, 48)}`);

      try {
        const res = await fetch('/api/sandbox/exec', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chatId,
            command: trimmed,
            cwd: cloudCwdRef.current,
            tier: 'vercel-sandbox',
          }),
        });

        const data = (await res.json()) as {
          ok: boolean;
          stdout?: string;
          stderr?: string;
          exitCode?: number;
          durationMs?: number;
          tier?: SandboxTier;
          cwd?: string;
          files?: WorkspaceFileEntry[];
          notice?: string;
          error?: string;
        };

        if (!data.ok) {
          writeTerm(`\x1b[31m${data.error ?? 'Execution failed'}\x1b[0m\r\n`);
        } else {
          if (data.notice) {
            writeTerm(`\x1b[33m[notice] ${data.notice}\x1b[0m\r\n`);
          }
          if (data.stdout) {
            writeTerm(data.stdout.replaceAll('\n', '\r\n'));
            if (!data.stdout.endsWith('\n')) writeTerm('\r\n');
          }
          if (data.stderr) {
            writeTerm(`\x1b[31m${data.stderr.replaceAll('\n', '\r\n')}\x1b[0m`);
            if (!data.stderr.endsWith('\n')) writeTerm('\r\n');
          }
          if (data.cwd) {
            cloudCwdRef.current = data.cwd;
          }
          if (data.files) {
            onFilesChanged?.(data.files);
          }
          const exitTag =
            data.exitCode === 0
              ? `\x1b[90m[${data.tier ?? 'sandbox'} · ${data.durationMs ?? 0}ms]\x1b[0m`
              : `\x1b[31m[exit ${data.exitCode} · ${data.durationMs ?? 0}ms]\x1b[0m`;
          writeTerm(`${exitTag}\r\n`);
          setStatusNotice(
            `${data.tier === 'vercel-sandbox' ? 'Cloud Sandbox VM' : 'Tier 1 fallback'} · exit ${data.exitCode ?? 0} (${data.durationMs ?? 0}ms)`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Network error';
        writeTerm(`\x1b[31m${msg}\x1b[0m\r\n`);
      } finally {
        cloudBusyRef.current = false;
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
      }
    },
    [chatId, onFilesChanged, writeTerm],
  );

  const handleTerminalReady = useCallback((wt: WTerm) => {
    wtermRef.current = wt;
    setShellReadyNonce((n) => n + 1);
  }, []);

  // Initialize shell whenever terminal becomes ready, chatId changes, or mode switches.
  useEffect(() => {
    if (!mounted || shellReadyNonce === 0) return;

    let cancelled = false;
    async function init() {
      const latestFiles = await fetchWorkspaceFiles();
      if (cancelled) return;

      if (mode === 'just-bash') {
        await attachLocalBash(latestFiles);
      } else {
        shellRef.current = null;
        cloudLineRef.current = '';
        writeTerm('\x1b[2J\x1b[H');
        writeTerm(
          '\x1b[1;36mWeb ADE\x1b[0m · \x1b[35mCloud Sandbox (VM)\x1b[0m  (\x1b[90m@vercel/sandbox · ports 3000/4848/8080\x1b[0m)\r\n',
        );
        writeTerm(
          '\x1b[90mCommands execute in your persistent Linux microVM (auto-falls back to Tier 1 if unconfigured).\x1b[0m\r\n',
        );
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
        setStatusNotice('Cloud Sandbox shell ready · /vercel/sandbox');
      }
      if (!cancelled) {
        setShellAttachedNonce((n) => n + 1);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [mounted, shellReadyNonce, mode, fetchWorkspaceFiles, attachLocalBash, writeTerm]);

  // Execute externally queued commands once the active shell is attached and consume immediately.
  useEffect(() => {
    if (
      !queuedCommand ||
      queuedCommand.id === lastQueuedIdRef.current ||
      shellReadyNonce === 0 ||
      shellAttachedNonce === 0
    ) {
      return;
    }
    if (modeRef.current === 'just-bash' && !shellRef.current) {
      return;
    }

    lastQueuedIdRef.current = queuedCommand.id;
    onQueuedCommandConsumedRef.current?.(queuedCommand.id);

    if (modeRef.current === 'just-bash' && shellRef.current) {
      void (async () => {
        for (const ch of queuedCommand.command) {
          await shellRef.current?.handleInput(ch);
        }
        await shellRef.current?.handleInput('\r');
      })();
    } else {
      writeTerm(`${queuedCommand.command}\r\n`);
      void runCloudCommand(queuedCommand.command);
    }
  }, [queuedCommand, runCloudCommand, shellReadyNonce, shellAttachedNonce, writeTerm]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (modeRef.current === 'just-bash') {
        void shellRef.current?.handleInput(data);
        return;
      }

      // Interactive line editing for Cloud Sandbox mode
      if (cloudBusyRef.current) {
        if (data === '\x03') {
          writeTerm('^C\r\n');
        }
        return;
      }

      if (data === '\r') {
        const line = cloudLineRef.current;
        cloudLineRef.current = '';
        writeTerm('\r\n');
        void runCloudCommand(line);
        return;
      }

      if (data === '\x03') {
        cloudLineRef.current = '';
        writeTerm('^C\r\n');
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
        return;
      }

      if (data === '\x0c') {
        writeTerm('\x1b[2J\x1b[H');
        writeTerm(formatCloudPrompt(cloudCwdRef.current));
        writeTerm(cloudLineRef.current);
        return;
      }

      if (data === '\x7f' || data === '\b') {
        if (cloudLineRef.current.length > 0) {
          cloudLineRef.current = cloudLineRef.current.slice(0, -1);
          writeTerm('\b \b');
        }
        return;
      }

      // Arrow Up / Down command history
      if (data === '\x1b[A') {
        const history = cloudHistoryRef.current;
        if (history.length === 0) return;
        const nextIdx =
          cloudHistoryIdxRef.current < 0
            ? history.length - 1
            : Math.max(0, cloudHistoryIdxRef.current - 1);
        cloudHistoryIdxRef.current = nextIdx;
        const prevLen = cloudLineRef.current.length;
        cloudLineRef.current = history[nextIdx];
        writeTerm(`\r\x1b[K${formatCloudPrompt(cloudCwdRef.current)}${cloudLineRef.current}`);
        if (prevLen < 0) return;
        return;
      }

      if (data === '\x1b[B') {
        const history = cloudHistoryRef.current;
        if (cloudHistoryIdxRef.current < 0) return;
        const nextIdx = cloudHistoryIdxRef.current + 1;
        if (nextIdx >= history.length) {
          cloudHistoryIdxRef.current = -1;
          cloudLineRef.current = '';
        } else {
          cloudHistoryIdxRef.current = nextIdx;
          cloudLineRef.current = history[nextIdx];
        }
        writeTerm(`\r\x1b[K${formatCloudPrompt(cloudCwdRef.current)}${cloudLineRef.current}`);
        return;
      }

      // Ignore other ANSI escape sequences in simple line mode
      if (data.startsWith('\x1b')) return;

      cloudLineRef.current += data;
      writeTerm(data);
    },
    [runCloudCommand, writeTerm],
  );

  // Bi-directional file sync between in-browser BashShell FS and server workspace store.
  const handleSyncFiles = useCallback(async () => {
    setIsSyncing(true);
    try {
      const bash = shellRef.current?.bash;
      if (modeRef.current === 'just-bash' && bash) {
        const fs = bash.fs as unknown as {
          getAllPaths?: () => string[];
          stat: (p: string) => Promise<{ isDirectory: boolean }>;
          readFile: (p: string, enc?: string) => Promise<string>;
          writeFile: (p: string, content: string) => Promise<void>;
        };

        if (typeof fs.getAllPaths === 'function') {
          const localMap: Record<string, string> = {};
          const paths = fs.getAllPaths();
          for (const abs of paths) {
            if (!abs.startsWith(`${WORKSPACE_PREFIX}/`)) continue;
            try {
              const st = await fs.stat(abs);
              if (st.isDirectory) continue;
              const rel = abs.slice(WORKSPACE_PREFIX.length + 1);
              localMap[rel] = await fs.readFile(abs, 'utf8');
            } catch {
              // Skip unreadable virtual entries.
            }
          }

          if (Object.keys(localMap).length > 0) {
            const pushRes = await fetch('/api/sandbox/files', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chatId, files: localMap }),
            });
            const pushed = (await pushRes.json()) as {
              ok: boolean;
              files?: WorkspaceFileEntry[];
              fileMap?: Record<string, string>;
            };
            if (pushed.ok) {
              if (pushed.files) onFilesChanged?.(pushed.files);
              if (pushed.fileMap) {
                setWorkspaceFiles(pushed.fileMap);
                for (const [rel, content] of Object.entries(pushed.fileMap)) {
                  await fs.writeFile(`${WORKSPACE_PREFIX}/${rel}`, content).catch(() => undefined);
                }
              }
              setStatusNotice(`Synced ${Object.keys(localMap).length} workspace files`);
              return;
            }
          }
        }
      }

      const latest = await fetchWorkspaceFiles();
      setStatusNotice(`Workspace refreshed (${Object.keys(latest).length} files)`);
    } finally {
      setIsSyncing(false);
    }
  }, [chatId, fetchWorkspaceFiles, onFilesChanged]);

  const handleClear = useCallback(() => {
    writeTerm('\x1b[2J\x1b[H');
    if (modeRef.current === 'just-bash') {
      const cwd = shellRef.current?.cwd ?? WORKSPACE_PREFIX;
      const short = cwd.replace(/^\/workspace/, '~/workspace') || '/';
      writeTerm(`\x1b[1;32made\x1b[0m:\x1b[1;34m${short}\x1b[0m$ `);
    } else {
      cloudLineRef.current = '';
      writeTerm(formatCloudPrompt(cloudCwdRef.current));
    }
    termRef.current?.focus();
  }, [writeTerm]);

  const handleUpgradeOrFx = useCallback(async () => {
    if (mode === 'vercel-sandbox') {
      writeTerm(
        'fx --version || echo "Install fx with: curl -fsSL https://fx.sh/setup.sh | bash"\r\n',
      );
      await runCloudCommand(
        'command -v fx >/dev/null 2>&1 && fx --version || echo "fx CLI not found — pre-bake with bun run sandbox:snapshot"',
      );
      return;
    }

    setIsUpgrading(true);
    setStatusNotice('Provisioning Cloud Sandbox (@vercel/sandbox)…');
    try {
      const res = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'upgrade' }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        degraded?: boolean;
        notice?: string;
        error?: string;
        status?: SandboxStatusInfo;
      };
      if (data.status) setSandboxStatus(data.status);

      if (data.ok) {
        setMode('vercel-sandbox');
        onTierChange?.('vercel-sandbox');
        setStatusNotice(data.notice ?? 'Upgraded to Cloud Sandbox VM');
      } else {
        setStatusNotice(data.notice ?? data.error ?? 'Cloud Sandbox unavailable');
        writeTerm(
          `\r\n\x1b[33m[sandbox] ${data.notice ?? data.error ?? 'Cloud credentials not configured.'}\x1b[0m\r\n`,
        );
      }
    } finally {
      setIsUpgrading(false);
    }
  }, [chatId, mode, onTierChange, runCloudCommand, writeTerm]);

  const handleSwitchMode = useCallback(
    (nextMode: TerminalMode) => {
      if (nextMode === mode) return;
      setMode(nextMode);
      onTierChange?.(nextMode);
    },
    [mode, onTierChange],
  );

  return (
    <div
      className={cn(
        'astryx-dark-surface flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0d0e11] font-mono text-zinc-100',
        className,
      )}
      style={{ colorScheme: 'dark' }}
    >
      {/* Terminal Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-white/10 bg-[#14151a] px-2.5 py-1.5 font-sans">
        {/* Tier Toggle: Instant Bash (WASM) <-> Cloud Sandbox (VM) */}
        <div
          className="flex shrink-0 items-center rounded-[var(--radius-inner)] border border-white/10 bg-black/40 p-0.5 text-xs"
          role="tablist"
          aria-label="Terminal execution tier"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'just-bash'}
            onClick={() => handleSwitchMode('just-bash')}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 py-1 font-medium transition',
              mode === 'just-bash'
                ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            <Cpu className="h-3.5 w-3.5 shrink-0" />
            <span>Instant Bash</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'vercel-sandbox'}
            onClick={() => handleSwitchMode('vercel-sandbox')}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 py-1 font-medium transition',
              mode === 'vercel-sandbox'
                ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            <Cloud className="h-3.5 w-3.5 shrink-0" />
            <span>Cloud Sandbox</span>
          </button>
        </div>

        {/* Quick Actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleClear}
            title="Clear terminal"
            className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner)] border border-white/10 bg-white/5 px-2 text-xs text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Clear</span>
          </button>

          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void handleSyncFiles()}
            title="Sync files between terminal and workspace"
            className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner)] border border-white/10 bg-white/5 px-2 text-xs text-zinc-300 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            {isSyncing ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />
            ) : (
              <FolderSync className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>Sync</span>
          </button>

          <button
            type="button"
            disabled={isUpgrading}
            onClick={() => void handleUpgradeOrFx()}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner)] px-2.5 text-xs font-medium transition disabled:opacity-50',
              mode === 'vercel-sandbox'
                ? 'border border-purple-500/30 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25'
                : 'bg-[#3d87ff] text-white hover:bg-[#5a9bff]',
            )}
          >
            {isUpgrading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{mode === 'vercel-sandbox' ? 'Run fx' : 'Upgrade VM'}</span>
          </button>

          {sandboxStatus?.previewUrl && onOpenTab && (
            <button
              type="button"
              onClick={() => onOpenTab('preview')}
              title={`Open preview (${sandboxStatus.previewUrl})`}
              className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner)] border border-emerald-500/30 bg-emerald-500/15 px-2 text-xs text-emerald-300 transition hover:bg-emerald-500/25"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span>:3000</span>
            </button>
          )}
        </div>
      </div>

      {/* Interactive @wterm/react Terminal Viewport */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        onClick={() => termRef.current?.focus()}
      >
        {mounted ? (
          <Terminal
            ref={termRef}
            autoResize
            renderer="dom"
            cursorBlink
            scrollbackLines={2000}
            webmcp={{ name: 'shell' }}
            onData={handleTerminalData}
            onReady={handleTerminalReady}
            className="h-full w-full"
            style={{
              height: '100%',
              width: '100%',
              fontFamily: 'var(--font-astryx-mono), "JetBrains Mono", monospace',
              fontSize: '13px',
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">
            Initializing @wterm WASM terminal…
          </div>
        )}
      </div>

      {/* Bottom Obsidian Telemetry Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-white/10 bg-[#14151a] px-3 py-1 font-sans text-[11px] text-zinc-400">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              mode === 'vercel-sandbox' ? 'bg-blue-400' : 'bg-emerald-400',
            )}
          />
          <span className="truncate">{statusNotice}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span>WebMCP:shell</span>
          <span>·</span>
          <span>{Object.keys(workspaceFiles).length} files</span>
        </div>
      </div>
    </div>
  );
}
