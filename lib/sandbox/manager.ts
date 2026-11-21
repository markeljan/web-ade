import path from 'node:path';
import type { Sandbox as VercelSandbox } from '@vercel/sandbox';
import { type BashToolkit, type Sandbox as BashToolSandbox, createBashTool } from 'bash-tool';
import { Bash, InMemoryFs } from 'just-bash';
import ms from 'ms';
import {
  deleteWorkspaceFile as dbDeleteWorkspaceFile,
  getChatById as dbGetChatById,
  getWorkspaceFiles as dbGetWorkspaceFiles,
  syncWorkspaceFiles as dbSyncWorkspaceFiles,
  upsertWorkspaceFile as dbUpsertWorkspaceFile,
} from '@/lib/db/queries';
import type { SandboxSessionInfo, SandboxTier, WorkspaceFileEntry } from '@/lib/types';

export const WORKSPACE_ROOT = '/workspace';
export const CLOUD_WORKSPACE_ROOT = '/vercel/sandbox';

export const STARTER_WORKSPACE_FILES: Record<string, string> = {
  'README.md': `# Web ADE Workspace

Welcome to your dual-tier agent workspace.

- **Tier 1 (Instant)**: Sandboxed \`just-bash\` in-memory filesystem — zero cold start, works everywhere.
- **Tier 2 (Cloud VM)**: Persistent \`@vercel/sandbox\` microVM with ports \`3000\` (preview), \`4848\` (agent-browser), and \`8080\` (screen-relay).

## Starter Files

- \`index.html\` — Live interactive HTML preview ready for the Preview pane.
- \`src/hello.ts\` — Sample TypeScript module.
- \`notes.md\` — Scratchpad for agent plans and observations.
`,
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Web ADE · Live Workspace Preview</title>
    <style>
      :root {
        color-scheme: light dark;
        --canvas: light-dark(#f1f4f7, #111112);
        --surface: light-dark(#ffffff, #1f1f22);
        --border: light-dark(rgba(5, 54, 89, 0.1), rgba(242, 244, 246, 0.12));
        --text: light-dark(#0f172a, #f2f4f6);
        --muted: light-dark(#475569, #9ca3af);
        --accent: light-dark(#0064e0, #3d87ff);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--canvas);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .card {
        width: min(560px, 100%);
        padding: 28px;
        border-radius: 20px;
        background: var(--surface);
        border: 1px solid var(--border);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.08);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
      }
      h1 {
        margin: 16px 0 8px;
        font-size: 24px;
        letter-spacing: -0.02em;
      }
      p {
        margin: 0 0 20px;
        line-height: 1.6;
        color: var(--muted);
        font-size: 14px;
      }
      .controls {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      button {
        appearance: none;
        border: none;
        border-radius: 12px;
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        background: var(--accent);
        cursor: pointer;
      }
      button:hover { opacity: 0.92; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        padding: 3px 6px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--text) 8%, transparent);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <span class="pill"><span class="dot"></span>Live Workspace Preview</span>
      <h1>Web ADE Sandbox Ready</h1>
      <p>
        Edit <code>index.html</code> from the Files editor, terminal, or chat agent to see
        instant updates right here.
      </p>
      <div class="controls">
        <button id="counter-btn" type="button">Clicks: 0</button>
        <span id="status" style="font-size: 12px; color: var(--muted)">Tier 1 · Instant Preview</span>
      </div>
    </main>
    <script>
      let count = 0;
      const btn = document.getElementById('counter-btn');
      btn?.addEventListener('click', () => {
        count += 1;
        btn.textContent = 'Clicks: ' + count;
      });
    </script>
  </body>
</html>
`,
  'src/hello.ts': `export interface GreetingOptions {
  name: string;
  tier?: 'just-bash' | 'vercel-sandbox';
}

export function formatGreeting({ name, tier = 'just-bash' }: GreetingOptions): string {
  return \`Hello, \${name}! Running on Web ADE (\${tier}).\`;
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('hello.ts')) {
  console.log(formatGreeting({ name: 'World' }));
}
`,
  'notes.md': `# Workspace Notes

- Use the **Terminal** tab for instant browser bash (\`@wterm/just-bash\`) or Cloud VM commands.
- Use the **Browser** tab to preview HTML artifacts, inspect websites, or stream a live desktop via \`screen-relay\`.
`,
};

export interface WorkspacePersistenceAdapter {
  getWorkspaceFiles(chatId: string): Promise<Array<{ path: string; content: string }>>;
  upsertWorkspaceFile(chatId: string, filePath: string, content: string): Promise<unknown>;
  deleteWorkspaceFile(chatId: string, filePath: string): Promise<unknown>;
  syncWorkspaceFiles(
    chatId: string,
    files: Record<string, string>,
    options?: { pruneMissing?: boolean },
  ): Promise<unknown>;
}

export interface ActiveCloudSandbox {
  chatId: string;
  sandboxName: string;
  sandbox: VercelSandbox;
  createdAt: string;
  status: SandboxSessionInfo['status'];
  previewUrl?: string;
  browserStreamUrl?: string;
  relayUrl?: string;
  relayToken?: string;
}

export interface SandboxStatusInfo extends SandboxSessionInfo {
  chatId: string;
  cloudAvailable: boolean;
  hasSnapshot: boolean;
  sandboxName?: string;
  ports: {
    preview?: string;
    agentBrowser?: string;
    screenRelay?: string;
  };
  fileCount: number;
  notice?: string;
}

export interface WorkspaceExecOptions {
  cwd?: string;
  tier?: SandboxTier;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  tier: SandboxTier;
  cwd: string;
  files: WorkspaceFileEntry[];
  changedFiles: string[];
  deletedFiles: string[];
  notice?: string;
}

export interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
  language: string;
  tier: SandboxTier;
}

export interface WorkspaceWriteResult {
  path: string;
  size: number;
  language: string;
  tier: SandboxTier;
  files: WorkspaceFileEntry[];
}

export interface WorkspaceDeleteResult {
  path: string;
  deleted: boolean;
  tier: SandboxTier;
  files: WorkspaceFileEntry[];
}

export interface WorkspaceBashToolOptions {
  tier?: SandboxTier;
  destination?: string;
  extraInstructions?: string;
  maxOutputLength?: number;
}

export interface WorkspaceBashToolkit extends BashToolkit {
  chatId: string;
  tier: SandboxTier;
}

export interface SandboxAccessResult {
  allowed: boolean;
  status?: 403 | 503;
  error?: string;
  userId?: string;
  effectiveChatId?: string;
}

export interface AuthorizeSandboxOptions {
  /**
   * Require verified ownership of a persisted chat (or an authenticated non-guest session
   * for their scoped default workspace). Used to guard host-billed Cloud Sandbox microVMs.
   */
  requireOwnedChat?: boolean;
}

/**
 * Fail-closed session ownership guard for sandbox & workspace routes.
 * - Scopes `'default'` strictly per session user (`default:${session.userId}`).
 * - Propagates DB lookup failures as HTTP 503 (never fails open).
 * - Denies cross-user access with HTTP 403 (allowing `visibility === 'public'` strictly on
 *   read-only GET requests).
 * - Rejects unowned/nonexistent arbitrary chat IDs for host-billed microVM provisioning.
 */
export async function authorizeSandboxChatAccess(
  request: Request,
  chatId: string,
  access: 'read' | 'write',
  options?: AuthorizeSandboxOptions,
): Promise<SandboxAccessResult> {
  const rawId = normalizeChatId(chatId);
  const { getServerSession } = await import('@/lib/auth/session');
  const session = await getServerSession(request.headers);
  const scopedDefaultId = `default:${session.userId}`;

  if (rawId === 'default' || rawId.startsWith('default:')) {
    if (rawId !== 'default' && rawId !== scopedDefaultId) {
      return {
        allowed: false,
        status: 403,
        error: 'Forbidden: you do not have access to this workspace.',
      };
    }

    if (options?.requireOwnedChat && (!session.isAuthenticated || session.isGuest)) {
      return {
        allowed: false,
        status: 403,
        error: 'Forbidden: sign in or start a saved chat session to provision a Cloud Sandbox VM.',
      };
    }

    return {
      allowed: true,
      userId: session.userId,
      effectiveChatId: scopedDefaultId,
    };
  }

  let chatRecord: Awaited<ReturnType<typeof dbGetChatById>>;
  try {
    chatRecord = await dbGetChatById(rawId);
  } catch {
    return {
      allowed: false,
      status: 503,
      error: 'Workspace authorization temporarily unavailable.',
    };
  }

  if (!chatRecord) {
    if (options?.requireOwnedChat) {
      return {
        allowed: false,
        status: 403,
        error: 'Forbidden: Cloud Sandbox VMs require an existing owned chat session.',
      };
    }
    return {
      allowed: true,
      userId: session.userId,
      effectiveChatId: rawId,
    };
  }

  if (chatRecord.userId === session.userId) {
    return {
      allowed: true,
      userId: session.userId,
      effectiveChatId: rawId,
    };
  }

  if (access === 'read' && chatRecord.visibility === 'public' && !options?.requireOwnedChat) {
    return {
      allowed: true,
      userId: session.userId,
      effectiveChatId: rawId,
    };
  }

  return {
    allowed: false,
    status: 403,
    error: 'Forbidden: you do not have access to this workspace.',
  };
}

// Persist in-memory workspace state and active cloud handles across Next.js dev HMR reloads.
const globalSandboxState = globalThis as typeof globalThis & {
  __webAdeWorkspaceStore?: Map<string, Map<string, string>>;
  __webAdeInitializedWorkspaces?: Set<string>;
  __webAdeCloudSandboxes?: Map<string, ActiveCloudSandbox>;
  __webAdePreferredTier?: Map<string, SandboxTier>;
  __webAdeDbAdapter?: WorkspacePersistenceAdapter | null;
};

function getMemoryStore(): Map<string, Map<string, string>> {
  if (!globalSandboxState.__webAdeWorkspaceStore) {
    globalSandboxState.__webAdeWorkspaceStore = new Map();
  }
  return globalSandboxState.__webAdeWorkspaceStore;
}

function getInitializedWorkspaces(): Set<string> {
  if (!globalSandboxState.__webAdeInitializedWorkspaces) {
    globalSandboxState.__webAdeInitializedWorkspaces = new Set();
  }
  return globalSandboxState.__webAdeInitializedWorkspaces;
}

function getCloudRegistry(): Map<string, ActiveCloudSandbox> {
  if (!globalSandboxState.__webAdeCloudSandboxes) {
    globalSandboxState.__webAdeCloudSandboxes = new Map();
  }
  return globalSandboxState.__webAdeCloudSandboxes;
}

function getPreferredTierRegistry(): Map<string, SandboxTier> {
  if (!globalSandboxState.__webAdePreferredTier) {
    globalSandboxState.__webAdePreferredTier = new Map();
  }
  return globalSandboxState.__webAdePreferredTier;
}

const defaultDbAdapter: WorkspacePersistenceAdapter = {
  getWorkspaceFiles: dbGetWorkspaceFiles,
  upsertWorkspaceFile: dbUpsertWorkspaceFile,
  deleteWorkspaceFile: dbDeleteWorkspaceFile,
  syncWorkspaceFiles: dbSyncWorkspaceFiles,
};

/**
 * Optional registration hook for overriding persistence in tests.
 */
export function registerWorkspacePersistence(adapter: WorkspacePersistenceAdapter | null): void {
  globalSandboxState.__webAdeDbAdapter = adapter;
}

async function resolveDbAdapter(): Promise<WorkspacePersistenceAdapter | null> {
  if (globalSandboxState.__webAdeDbAdapter !== undefined) {
    return globalSandboxState.__webAdeDbAdapter;
  }
  return defaultDbAdapter;
}

export function normalizeChatId(chatId?: string | null): string {
  const cleaned = (chatId ?? 'default').trim();
  return cleaned.length > 0 ? cleaned : 'default';
}

export function sanitizeSandboxName(chatId: string): string {
  const slug = normalizeChatId(chatId)
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `ade-${slug || 'workspace'}`;
}

export function normalizeWorkspacePath(inputPath: string): string {
  const raw = inputPath.replaceAll('\\', '/').trim();
  let stripped = raw;

  if (
    stripped === WORKSPACE_ROOT ||
    stripped === CLOUD_WORKSPACE_ROOT ||
    stripped === '.' ||
    stripped === '/'
  ) {
    throw new Error('Path must point to a file inside the workspace.');
  }

  if (stripped.startsWith(`${WORKSPACE_ROOT}/`)) {
    stripped = stripped.slice(WORKSPACE_ROOT.length + 1);
  } else if (stripped.startsWith(`${CLOUD_WORKSPACE_ROOT}/`)) {
    stripped = stripped.slice(CLOUD_WORKSPACE_ROOT.length + 1);
  }

  stripped = stripped.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const segments = stripped.split('/').filter(Boolean);

  if (segments.length === 0) {
    throw new Error('Invalid empty workspace path.');
  }
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Invalid path traversal segment in "${inputPath}".`);
  }

  return segments.join('/');
}

export function inferLanguageFromPath(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
    case '.scss':
      return 'css';
    case '.json':
    case '.jsonc':
      return 'json';
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.py':
      return 'python';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'bash';
    case '.sql':
      return 'sql';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.xml':
    case '.svg':
      return 'xml';
    default:
      return 'text';
  }
}

export function hasVercelSandboxCredentials(): boolean {
  if (process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL === '1') {
    return true;
  }
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) {
    return true;
  }
  return Boolean(process.env.VERCEL_TOKEN);
}

export function hasSandboxSnapshotConfigured(): boolean {
  return Boolean(process.env.VERCEL_SANDBOX_SNAPSHOT_ID?.trim());
}

export function getActiveCloudSandbox(chatId: string): ActiveCloudSandbox | undefined {
  return getCloudRegistry().get(normalizeChatId(chatId));
}

export function getActiveTier(chatId: string): SandboxTier {
  const id = normalizeChatId(chatId);
  if (getCloudRegistry().has(id)) {
    return 'vercel-sandbox';
  }
  return getPreferredTierRegistry().get(id) ?? 'just-bash';
}

export function setPreferredTier(chatId: string, tier: SandboxTier): void {
  getPreferredTierRegistry().set(normalizeChatId(chatId), tier);
}

function getMemoryFileMap(chatId: string): Map<string, string> {
  const id = normalizeChatId(chatId);
  const store = getMemoryStore();
  let map = store.get(id);
  if (!map) {
    map = new Map<string, string>();
    store.set(id, map);
  }
  return map;
}

async function hydrateWorkspaceRecord(chatId: string): Promise<Record<string, string>> {
  const id = normalizeChatId(chatId);
  const memMap = getMemoryFileMap(id);
  const initialized = getInitializedWorkspaces();

  const db = await resolveDbAdapter();
  if (db) {
    try {
      const rows = await db.getWorkspaceFiles(id);
      if (Array.isArray(rows) && rows.length > 0) {
        memMap.clear();
        const record: Record<string, string> = {};
        for (const row of rows) {
          try {
            const rel = normalizeWorkspacePath(row.path);
            memMap.set(rel, row.content);
            record[rel] = row.content;
          } catch {
            // Skip invalid paths if any exist in external storage.
          }
        }
        initialized.add(id);
        return record;
      }
    } catch {
      // Degrade cleanly to in-memory cache if DB read fails.
    }
  }

  if (memMap.size > 0 || initialized.has(id)) {
    return Object.fromEntries(memMap.entries());
  }

  // Seed fresh workspace with clean starter files once.
  const seeded = { ...STARTER_WORKSPACE_FILES };
  for (const [relPath, content] of Object.entries(seeded)) {
    memMap.set(relPath, content);
  }
  initialized.add(id);

  if (db) {
    try {
      await db.syncWorkspaceFiles(id, seeded);
    } catch {
      // Ignore DB seed failure (e.g. anonymous chat before chat row exists).
    }
  }

  return seeded;
}

async function persistWorkspaceRecord(
  chatId: string,
  files: Record<string, string>,
): Promise<void> {
  const id = normalizeChatId(chatId);
  const memMap = getMemoryFileMap(id);
  getInitializedWorkspaces().add(id);
  memMap.clear();
  for (const [relPath, content] of Object.entries(files)) {
    memMap.set(relPath, content);
  }

  const db = await resolveDbAdapter();
  if (db) {
    try {
      await db.syncWorkspaceFiles(id, files, { pruneMissing: true });
    } catch {
      // Keep in-memory workspace intact even if DB persistence fails.
    }
  }
}

export function buildWorkspaceFileEntries(
  files: Record<string, string>,
  updatedAt = new Date().toISOString(),
): WorkspaceFileEntry[] {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relPath, content]) => ({
      path: relPath,
      name: path.posix.basename(relPath),
      type: 'file',
      size: Buffer.byteLength(content, 'utf8'),
      language: inferLanguageFromPath(relPath),
      updatedAt,
    }));
}

function safeSandboxDomain(sandbox: VercelSandbox, port: number): string | undefined {
  try {
    return sandbox.domain(port);
  } catch {
    return undefined;
  }
}

async function syncFilesToCloudSandbox(
  sandbox: VercelSandbox,
  files: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(files);
  if (entries.length === 0) return;

  const dirs = new Set<string>();
  for (const [relPath] of entries) {
    const dir = path.posix.dirname(relPath);
    if (dir && dir !== '.') {
      dirs.add(`${CLOUD_WORKSPACE_ROOT}/${dir}`);
    }
  }

  for (const dir of dirs) {
    await sandbox.fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  }

  await sandbox.writeFiles(
    entries.map(([relPath, content]) => ({
      path: `${CLOUD_WORKSPACE_ROOT}/${relPath}`,
      content: Buffer.from(content, 'utf8'),
    })),
  );
}

async function pullFilesFromCloudSandbox(
  sandbox: VercelSandbox,
): Promise<Record<string, string> | null> {
  try {
    const findResult = await sandbox.runCommand('bash', [
      '-lc',
      `cd "${CLOUD_WORKSPACE_ROOT}" && find . -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -size -256k | sed 's|^\\./||' | head -n 120`,
    ]);
    if (findResult.exitCode !== 0) {
      return null;
    }

    const rawList = (await findResult.stdout()).trim();
    if (!rawList) {
      return {};
    }

    const relPaths = rawList
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const record: Record<string, string> = {};
    for (const relPath of relPaths) {
      try {
        const normalized = normalizeWorkspacePath(relPath);
        const content = await sandbox.fs.readFile(`${CLOUD_WORKSPACE_ROOT}/${normalized}`, 'utf8');
        record[normalized] = content;
      } catch {
        // Skip binary/unreadable files cleanly.
      }
    }
    return record;
  } catch {
    return null;
  }
}

export async function getOrCreateCloudSandbox(
  chatId: string,
  options?: { snapshotId?: string; hydrateFiles?: boolean },
): Promise<{ ok: true; entry: ActiveCloudSandbox } | { ok: false; error: string }> {
  const id = normalizeChatId(chatId);
  const registry = getCloudRegistry();
  const existing = registry.get(id);

  if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
    return { ok: true, entry: existing };
  }

  if (!hasVercelSandboxCredentials()) {
    return {
      ok: false,
      error:
        'Vercel Sandbox credentials not configured (set VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID).',
    };
  }

  const sandboxName = sanitizeSandboxName(id);
  const snapshotId = (options?.snapshotId ?? process.env.VERCEL_SANDBOX_SNAPSHOT_ID ?? '').trim();

  try {
    const { Sandbox: VercelSandboxClass } = await import('@vercel/sandbox');
    const baseOptions = {
      name: sandboxName,
      ports: [3000, 4848, 8080],
      timeout: ms('15m'),
      persistent: true,
      env: {
        AGENT_BROWSER_STREAM_PORT: '4848',
      },
      onCreate: async (sbx: VercelSandbox) => {
        const currentFiles = await hydrateWorkspaceRecord(id);
        await syncFilesToCloudSandbox(sbx, currentFiles);
      },
    };

    const sandbox = snapshotId
      ? await VercelSandboxClass.getOrCreate({
          ...baseOptions,
          source: { type: 'snapshot', snapshotId },
        })
      : await VercelSandboxClass.getOrCreate(baseOptions);

    if (options?.hydrateFiles) {
      const currentFiles = await hydrateWorkspaceRecord(id);
      await syncFilesToCloudSandbox(sandbox, currentFiles).catch(() => undefined);
    }

    const entry: ActiveCloudSandbox = {
      chatId: id,
      sandboxName,
      sandbox,
      createdAt: sandbox.createdAt?.toISOString?.() ?? new Date().toISOString(),
      status: 'ready',
      previewUrl: safeSandboxDomain(sandbox, 3000),
      browserStreamUrl: safeSandboxDomain(sandbox, 4848),
      relayUrl: safeSandboxDomain(sandbox, 8080),
    };

    registry.set(id, entry);
    setPreferredTier(id, 'vercel-sandbox');
    return { ok: true, entry };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize Vercel Sandbox';
    return { ok: false, error: message };
  }
}

export async function stopCloudSandbox(
  chatId: string,
): Promise<{ stopped: boolean; notice?: string }> {
  const id = normalizeChatId(chatId);
  const registry = getCloudRegistry();
  const existing = registry.get(id);
  setPreferredTier(id, 'just-bash');

  if (!existing) {
    return { stopped: false, notice: 'No active cloud sandbox for this session.' };
  }

  registry.delete(id);
  try {
    await existing.sandbox.stop();
    return { stopped: true, notice: `Stopped cloud sandbox ${existing.sandboxName}.` };
  } catch (error) {
    return {
      stopped: true,
      notice: error instanceof Error ? error.message : 'Cloud sandbox detached.',
    };
  }
}

export async function getSandboxStatus(chatId: string): Promise<SandboxStatusInfo> {
  const id = normalizeChatId(chatId);
  const files = await hydrateWorkspaceRecord(id);
  const activeCloud = getCloudRegistry().get(id);
  const cloudAvailable = hasVercelSandboxCredentials();
  const hasSnapshot = hasSandboxSnapshotConfigured();

  if (activeCloud) {
    return {
      id: activeCloud.sandboxName,
      chatId: id,
      tier: 'vercel-sandbox',
      status: activeCloud.status,
      sandboxName: activeCloud.sandboxName,
      previewUrl: activeCloud.previewUrl,
      relayUrl: activeCloud.relayUrl,
      browserStreamUrl: activeCloud.browserStreamUrl,
      ports: {
        preview: activeCloud.previewUrl,
        agentBrowser: activeCloud.browserStreamUrl,
        screenRelay: activeCloud.relayUrl,
      },
      createdAt: activeCloud.createdAt,
      cloudAvailable,
      hasSnapshot,
      fileCount: Object.keys(files).length,
    };
  }

  return {
    id: `local-${sanitizeSandboxName(id)}`,
    chatId: id,
    tier: 'just-bash',
    status: 'ready',
    ports: {},
    createdAt: new Date().toISOString(),
    cloudAvailable,
    hasSnapshot,
    fileCount: Object.keys(files).length,
    notice: cloudAvailable
      ? 'Running in Tier 1 instant just-bash. Upgrade to Cloud Sandbox anytime for a full Linux VM.'
      : 'Running in Tier 1 instant just-bash (zero-config local/serverless mode).',
  };
}

async function snapshotInMemoryFs(fs: InMemoryFs): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const prefix = `${WORKSPACE_ROOT}/`;
  const allPaths = fs.getAllPaths();

  for (const absPath of allPaths) {
    if (!absPath.startsWith(prefix)) continue;
    try {
      const stat = await fs.stat(absPath);
      if (stat.isDirectory) continue;
      const relPath = normalizeWorkspacePath(absPath);
      const content = await fs.readFile(absPath, 'utf8');
      result[relPath] = content;
    } catch {
      // Skip non-readable or transient paths.
    }
  }

  return result;
}

function diffWorkspaceRecords(
  before: Record<string, string>,
  after: Record<string, string>,
): { changedFiles: string[]; deletedFiles: string[] } {
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [relPath, content] of Object.entries(after)) {
    if (before[relPath] !== content) {
      changedFiles.push(relPath);
    }
  }
  for (const relPath of Object.keys(before)) {
    if (!(relPath in after)) {
      deletedFiles.push(relPath);
    }
  }

  return {
    changedFiles: changedFiles.sort(),
    deletedFiles: deletedFiles.sort(),
  };
}

function resolveCwd(root: string, cwd?: string): string {
  if (
    !cwd ||
    cwd === '.' ||
    cwd === '/' ||
    cwd === WORKSPACE_ROOT ||
    cwd === CLOUD_WORKSPACE_ROOT
  ) {
    return root;
  }
  try {
    const rel = normalizeWorkspacePath(cwd);
    return `${root}/${rel}`;
  } catch {
    return root;
  }
}

async function execInTier1(
  chatId: string,
  command: string,
  options?: WorkspaceExecOptions,
  notice?: string,
): Promise<WorkspaceExecResult> {
  const startedAt = performance.now();
  const beforeFiles = await hydrateWorkspaceRecord(chatId);
  const initialFiles: Record<string, string> = {};

  for (const [relPath, content] of Object.entries(beforeFiles)) {
    initialFiles[`${WORKSPACE_ROOT}/${relPath}`] = content;
  }

  const fs = new InMemoryFs(initialFiles);
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true }).catch(() => undefined);

  const cwd = resolveCwd(WORKSPACE_ROOT, options?.cwd);
  const bash = new Bash({
    fs,
    cwd: WORKSPACE_ROOT,
    env: {
      HOME: WORKSPACE_ROOT,
      PWD: cwd,
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      ...(options?.env ?? {}),
    },
  });

  const execRes = await bash.exec(command, {
    cwd,
    env: options?.env,
    signal: options?.signal,
  });

  const afterFiles = await snapshotInMemoryFs(fs);
  const { changedFiles, deletedFiles } = diffWorkspaceRecords(beforeFiles, afterFiles);

  if (changedFiles.length > 0 || deletedFiles.length > 0) {
    await persistWorkspaceRecord(chatId, afterFiles);
  }

  return {
    stdout: execRes.stdout,
    stderr: execRes.stderr,
    exitCode: execRes.exitCode,
    durationMs: Math.round(performance.now() - startedAt),
    tier: 'just-bash',
    cwd,
    files: buildWorkspaceFileEntries(afterFiles),
    changedFiles,
    deletedFiles,
    notice,
  };
}

function shellEscapeSingle(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function execCommand(
  chatId: string,
  command: string,
  options?: WorkspaceExecOptions,
): Promise<WorkspaceExecResult> {
  const id = normalizeChatId(chatId);
  const requestedTier = options?.tier ?? getActiveTier(id);

  if (requestedTier === 'vercel-sandbox') {
    const cloud = await getOrCreateCloudSandbox(id);
    if (cloud.ok) {
      const startedAt = performance.now();
      const beforeFiles = await hydrateWorkspaceRecord(id);
      const cwd = resolveCwd(CLOUD_WORKSPACE_ROOT, options?.cwd);

      try {
        const script = `cd ${shellEscapeSingle(cwd)} && ${command}`;
        const cmdResult = await cloud.entry.sandbox.runCommand('bash', ['-lc', script], {
          timeoutMs: options?.timeoutMs ?? 60_000,
          signal: options?.signal,
        });

        const [stdout, stderr] = await Promise.all([cmdResult.stdout(), cmdResult.stderr()]);
        const pulled = await pullFilesFromCloudSandbox(cloud.entry.sandbox);
        const afterFiles = pulled ?? beforeFiles;
        const { changedFiles, deletedFiles } = diffWorkspaceRecords(beforeFiles, afterFiles);

        if (pulled && (changedFiles.length > 0 || deletedFiles.length > 0)) {
          await persistWorkspaceRecord(id, afterFiles);
        }

        return {
          stdout,
          stderr,
          exitCode: cmdResult.exitCode,
          durationMs: Math.round(performance.now() - startedAt),
          tier: 'vercel-sandbox',
          cwd,
          files: buildWorkspaceFileEntries(afterFiles),
          changedFiles,
          deletedFiles,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cloud sandbox command failed';
        return execInTier1(
          id,
          command,
          options,
          `Cloud Sandbox execution failed (${message}); fell back to Tier 1 just-bash.`,
        );
      }
    }

    return execInTier1(
      id,
      command,
      options,
      `Cloud Sandbox unavailable (${cloud.error}); executed in Tier 1 just-bash.`,
    );
  }

  return execInTier1(id, command, options);
}

export async function getAllFilesRecord(
  chatId: string,
  tier?: SandboxTier,
): Promise<Record<string, string>> {
  const id = normalizeChatId(chatId);
  const activeTier = tier ?? getActiveTier(id);

  if (activeTier === 'vercel-sandbox') {
    const cloud = getActiveCloudSandbox(id);
    if (cloud) {
      const pulled = await pullFilesFromCloudSandbox(cloud.sandbox);
      if (pulled) {
        await persistWorkspaceRecord(id, pulled);
        return pulled;
      }
    }
  }

  return hydrateWorkspaceRecord(id);
}

export async function listFiles(chatId: string, tier?: SandboxTier): Promise<WorkspaceFileEntry[]> {
  const record = await getAllFilesRecord(chatId, tier);
  return buildWorkspaceFileEntries(record);
}

export async function readFile(
  chatId: string,
  filePath: string,
  tier?: SandboxTier,
): Promise<WorkspaceReadResult> {
  const id = normalizeChatId(chatId);
  const relPath = normalizeWorkspacePath(filePath);
  const activeTier = tier ?? getActiveTier(id);

  if (activeTier === 'vercel-sandbox') {
    const cloud = getActiveCloudSandbox(id);
    if (cloud) {
      try {
        const content = await cloud.sandbox.fs.readFile(
          `${CLOUD_WORKSPACE_ROOT}/${relPath}`,
          'utf8',
        );
        return {
          path: relPath,
          content,
          size: Buffer.byteLength(content, 'utf8'),
          language: inferLanguageFromPath(relPath),
          tier: 'vercel-sandbox',
        };
      } catch {
        // Fall through to workspace store lookup.
      }
    }
  }

  const record = await hydrateWorkspaceRecord(id);
  if (!(relPath in record)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const content = record[relPath];

  return {
    path: relPath,
    content,
    size: Buffer.byteLength(content, 'utf8'),
    language: inferLanguageFromPath(relPath),
    tier:
      activeTier === 'vercel-sandbox' && getActiveCloudSandbox(id) ? 'vercel-sandbox' : 'just-bash',
  };
}

export async function writeFile(
  chatId: string,
  filePath: string,
  content: string,
  tier?: SandboxTier,
): Promise<WorkspaceWriteResult> {
  const id = normalizeChatId(chatId);
  const relPath = normalizeWorkspacePath(filePath);
  const activeTier = tier ?? getActiveTier(id);
  let effectiveTier: SandboxTier = 'just-bash';

  if (activeTier === 'vercel-sandbox') {
    const cloud = getActiveCloudSandbox(id);
    if (cloud) {
      try {
        const absPath = `${CLOUD_WORKSPACE_ROOT}/${relPath}`;
        const dir = path.posix.dirname(absPath);
        await cloud.sandbox.fs.mkdir(dir, { recursive: true }).catch(() => undefined);
        await cloud.sandbox.fs.writeFile(absPath, content, 'utf8');
        effectiveTier = 'vercel-sandbox';
      } catch {
        effectiveTier = 'just-bash';
      }
    }
  }

  const record = await hydrateWorkspaceRecord(id);
  record[relPath] = content;

  const memMap = getMemoryFileMap(id);
  memMap.set(relPath, content);

  const db = await resolveDbAdapter();
  if (db) {
    try {
      await db.upsertWorkspaceFile(id, relPath, content);
    } catch {
      // In-memory store remains updated.
    }
  }

  return {
    path: relPath,
    size: Buffer.byteLength(content, 'utf8'),
    language: inferLanguageFromPath(relPath),
    tier: effectiveTier,
    files: buildWorkspaceFileEntries(record),
  };
}

export async function deleteFile(
  chatId: string,
  filePath: string,
  tier?: SandboxTier,
): Promise<WorkspaceDeleteResult> {
  const id = normalizeChatId(chatId);
  const relPath = normalizeWorkspacePath(filePath);
  const activeTier = tier ?? getActiveTier(id);
  let effectiveTier: SandboxTier = 'just-bash';

  if (activeTier === 'vercel-sandbox') {
    const cloud = getActiveCloudSandbox(id);
    if (cloud) {
      try {
        await cloud.sandbox.fs.rm(`${CLOUD_WORKSPACE_ROOT}/${relPath}`, { force: true });
        effectiveTier = 'vercel-sandbox';
      } catch {
        effectiveTier = 'just-bash';
      }
    }
  }

  const record = await hydrateWorkspaceRecord(id);
  const existed = relPath in record;
  delete record[relPath];

  getInitializedWorkspaces().add(id);
  const memMap = getMemoryFileMap(id);
  memMap.delete(relPath);

  const db = await resolveDbAdapter();
  if (db) {
    try {
      await db.deleteWorkspaceFile(id, relPath);
    } catch {
      // Keep in-memory state consistent.
    }
  }

  return {
    path: relPath,
    deleted: existed,
    tier: effectiveTier,
    files: buildWorkspaceFileEntries(record),
  };
}

/**
 * Creates an AI SDK 7 `bash-tool` toolkit bound to a chat workspace.
 * Works seamlessly across Tier 1 (`just-bash`) and Tier 2 (`@vercel/sandbox`),
 * persisting file mutations automatically after every call.
 */
export async function createWorkspaceBashTool(
  chatId: string,
  options?: SandboxTier | WorkspaceBashToolOptions,
): Promise<WorkspaceBashToolkit> {
  const id = normalizeChatId(chatId);
  const opts: WorkspaceBashToolOptions =
    typeof options === 'string' ? { tier: options } : (options ?? {});
  const tier = opts.tier ?? getActiveTier(id);

  // Hydrate initial files so starter files are ready immediately.
  await hydrateWorkspaceRecord(id);

  const adapter: BashToolSandbox = {
    async executeCommand(command: string) {
      const result = await execCommand(id, command, { tier });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    async readFile(filePath: string) {
      const result = await readFile(id, filePath, tier);
      return result.content;
    },
    async writeFiles(files) {
      for (const file of files) {
        const text =
          typeof file.content === 'string' ? file.content : file.content.toString('utf8');
        await writeFile(id, file.path, text, tier);
      }
    },
  };

  const toolkit = await createBashTool({
    sandbox: adapter,
    destination: opts.destination ?? WORKSPACE_ROOT,
    extraInstructions:
      opts.extraInstructions ??
      `Workspace files live under ${WORKSPACE_ROOT} and persist across turns. Keep outputs concise.`,
    maxOutputLength: opts.maxOutputLength ?? 30_000,
  });

  return {
    ...toolkit,
    chatId: id,
    tier,
  };
}
