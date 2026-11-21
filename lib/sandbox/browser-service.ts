import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { runAgentBrowserCommand, type VercelSandboxSession } from '@agent-browser/sandbox/vercel';
import type { AgentBrowserSession } from 'remote-agent-browser';
import {
  getActiveCloudSandbox,
  getAllFilesRecord,
  hasVercelSandboxCredentials,
  normalizeChatId,
  sanitizeSandboxName,
} from '@/lib/sandbox/manager';
import type { BrowserControlState, BrowserStreamMode, BrowserViewport } from '@/lib/types';

const execFileAsync = promisify(execFile);

export interface BrowserSnapshotLink {
  ref: string;
  text: string;
  href: string;
}

export interface BrowserSnapshotInput {
  ref: string;
  type: string;
  name?: string;
  placeholder?: string;
  value?: string;
}

export interface BrowserConsoleEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface BrowserActionResult {
  ok: boolean;
  action: string;
  mode: BrowserStreamMode;
  backend:
    | 'screen-relay'
    | 'agent-browser-sandbox'
    | 'agent-browser-local'
    | 'remote-agent-browser'
    | 'http-snapshot'
    | 'workspace-preview';
  url: string;
  title?: string;
  textSummary?: string;
  snapshotTree?: string;
  links?: BrowserSnapshotLink[];
  inputs?: BrowserSnapshotInput[];
  htmlPreview?: string;
  screenshotDataUrl?: string;
  streamUrl?: string;
  previewUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: BrowserViewport;
  consoleLogs?: BrowserConsoleEntry[];
  statusMessage?: string;
  error?: string;
}

export interface BrowserStatusPayload extends BrowserControlState {
  chatId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  availableModes: {
    preview: boolean;
    screenRelay: boolean;
    agentBrowser: boolean;
    snapshot: boolean;
  };
  backend: BrowserActionResult['backend'];
  snapshotTree?: string;
  textSummary?: string;
  links?: BrowserSnapshotLink[];
  inputs?: BrowserSnapshotInput[];
  htmlPreview?: string;
  consoleLogs: BrowserConsoleEntry[];
}

export interface RelayGrantResult {
  ok: boolean;
  wsUrl?: string;
  grantToken?: string;
  authProtocol?: 'ticket';
  role: 'watch' | 'control';
  expiresAt?: string;
  origin?: string;
  loopbackNoAuth?: boolean;
  capabilities?: Record<string, unknown>;
  error?: string;
  hint?: string;
}

interface StoredBrowserSession {
  chatId: string;
  mode: BrowserStreamMode;
  backend: BrowserActionResult['backend'];
  url: string;
  title: string;
  history: string[];
  historyIndex: number;
  viewport: BrowserViewport;
  isHumanInControl: boolean;
  streamUrl?: string;
  previewUrl?: string;
  textSummary?: string;
  snapshotTree?: string;
  links: BrowserSnapshotLink[];
  inputs: BrowserSnapshotInput[];
  htmlPreview?: string;
  lastScreenshotDataUrl?: string;
  consoleLogs: BrowserConsoleEntry[];
  statusMessage?: string;
  remoteSession?: AgentBrowserSession;
}

const globalBrowserState = globalThis as typeof globalThis & {
  __webAdeBrowserSessions?: Map<string, StoredBrowserSession>;
  __webAdeLocalAgentBrowserChecked?: boolean;
  __webAdeLocalAgentBrowserAvailable?: boolean;
};

function getSessionMap(): Map<string, StoredBrowserSession> {
  if (!globalBrowserState.__webAdeBrowserSessions) {
    globalBrowserState.__webAdeBrowserSessions = new Map();
  }
  return globalBrowserState.__webAdeBrowserSessions;
}

function getOrCreateSession(chatId: string): StoredBrowserSession {
  const id = normalizeChatId(chatId);
  const map = getSessionMap();
  let session = map.get(id);
  if (!session) {
    session = {
      chatId: id,
      mode: 'preview',
      backend: 'workspace-preview',
      url: 'workspace://index.html',
      title: 'Web ADE · Live Workspace Preview',
      history: ['workspace://index.html'],
      historyIndex: 0,
      viewport: { width: 1280, height: 800 },
      isHumanInControl: false,
      links: [],
      inputs: [],
      consoleLogs: [],
      statusMessage: 'Ready · Workspace preview active',
    };
    map.set(id, session);
  }
  return session;
}

function pushHistory(session: StoredBrowserSession, url: string): void {
  if (session.history[session.historyIndex] === url) return;
  const nextHistory = session.history.slice(0, session.historyIndex + 1);
  nextHistory.push(url);
  if (nextHistory.length > 50) {
    nextHistory.shift();
  }
  session.history = nextHistory;
  session.historyIndex = nextHistory.length - 1;
}

function appendConsoleLog(
  session: StoredBrowserSession,
  level: BrowserConsoleEntry['level'],
  message: string,
): void {
  session.consoleLogs.push({
    level,
    message,
    timestamp: new Date().toISOString(),
  });
  if (session.consoleLogs.length > 80) {
    session.consoleLogs.shift();
  }
}

async function isLocalAgentBrowserInstalled(): Promise<boolean> {
  if (globalBrowserState.__webAdeLocalAgentBrowserChecked) {
    return Boolean(globalBrowserState.__webAdeLocalAgentBrowserAvailable);
  }
  globalBrowserState.__webAdeLocalAgentBrowserChecked = true;
  try {
    await execFileAsync('agent-browser', ['--version'], { timeout: 2_000 });
    globalBrowserState.__webAdeLocalAgentBrowserAvailable = true;
  } catch {
    globalBrowserState.__webAdeLocalAgentBrowserAvailable = false;
  }
  return Boolean(globalBrowserState.__webAdeLocalAgentBrowserAvailable);
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isRestrictedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
  return false;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const lower = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!lower) return true;

  // Blocked internal / metadata hostnames and reserved TLDs
  if (
    lower === 'localhost' ||
    lower === 'metadata' ||
    lower === 'metadata.goog' ||
    lower === 'metadata.google.internal' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.home.arpa')
  ) {
    return true;
  }

  // IPv4 checks (WHATWG URL normalizes decimal/hex/octal IPv4 literals to dotted quad)
  const ipv4 = parseIpv4Octets(lower);
  if (ipv4) {
    return isRestrictedIpv4(ipv4);
  }

  // IPv6 checks (strictly scoped to IPv6 literals containing ':' so domains like fcdn.com / fdic.gov pass)
  if (lower.includes(':')) {
    const bare = lower.split('%')[0] ?? lower;
    if (
      bare === '::' ||
      bare === '::1' ||
      /^0*:0*:0*:0*:0*:0*:0*:[01]$/.test(bare) ||
      bare.startsWith('::ffff:') ||
      bare.startsWith('0:0:0:0:0:ffff:') ||
      /^f[cd][0-9a-f]{0,2}:/.test(bare) || // fc00::/7 ULA
      /^fe[89ab][0-9a-f]:/.test(bare) || // fe80::/10 link-local
      /^ff[0-9a-f]{0,2}:/.test(bare) // ff00::/8 multicast
    ) {
      return true;
    }
  }

  return false;
}

export function validateExternalUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL protocol "${parsed.protocol}". Only http and https are allowed.`,
    );
  }

  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error(`Host "${parsed.hostname}" is restricted for security.`);
  }

  return parsed;
}

export type DnsUrlValidationResult = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Validates an external URL syntactically AND resolves DNS (`A` + `AAAA`) to ensure
 * EVERY resolved IP address is public (not loopback, private, link-local, CGNAT, or metadata).
 */
export async function validateExternalUrlWithDns(rawUrl: string): Promise<DnsUrlValidationResult> {
  let parsed: URL;
  try {
    parsed = validateExternalUrl(rawUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `Invalid URL: "${rawUrl}"`,
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parseIpv4Octets(host) || host.includes(':')) {
    return { ok: true, url: parsed };
  }

  try {
    const records = await dnsLookup(host, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, error: `Unable to resolve host "${parsed.hostname}".` };
    }
    for (const record of records) {
      if (!record.address || isPrivateOrBlockedHost(record.address)) {
        return {
          ok: false,
          error: `Host "${parsed.hostname}" resolves to a restricted address.`,
        };
      }
    }
    return { ok: true, url: parsed };
  } catch {
    return { ok: false, error: `Unable to resolve host "${parsed.hostname}".` };
  }
}

/**
 * Streams a `Response` body up to `maxBytes`, cancelling the underlying stream
 * immediately once the byte cap is reached to prevent memory exhaustion.
 */
export async function readResponseTextBounded(
  response: Response,
  maxBytes = 512 * 1024,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let totalBytes = 0;
  let output = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - totalBytes;
      if (value.byteLength >= remaining) {
        output += decoder.decode(value.subarray(0, remaining), { stream: false });
        totalBytes = maxBytes;
        await reader.cancel().catch(() => undefined);
        return output;
      }

      totalBytes += value.byteLength;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

export interface SafeExternalFetchOptions extends Omit<RequestInit, 'redirect'> {
  maxRedirects?: number;
  timeoutMs?: number;
}

/**
 * SSRF-safe external HTTP fetch that validates the initial URL and EVERY HTTP redirect
 * `Location` hop against `validateExternalUrlWithDns` using `redirect: 'manual'`.
 */
export async function safeExternalFetch(
  rawUrl: string,
  options?: SafeExternalFetchOptions,
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options?.maxRedirects ?? 5;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const { maxRedirects: _mr, timeoutMs: _tm, signal: outerSignal, ...fetchInit } = options ?? {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromOuter = () => controller.abort();
  outerSignal?.addEventListener('abort', abortFromOuter, { once: true });

  try {
    const initialCheck = await validateExternalUrlWithDns(rawUrl);
    if (!initialCheck.ok) {
      throw new Error(initialCheck.error);
    }
    let currentUrl = initialCheck.url.toString();

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await fetch(currentUrl, {
        ...fetchInit,
        redirect: 'manual',
        signal: controller.signal,
      });

      const isRedirect =
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308;

      if (!isRedirect) {
        return { response, finalUrl: currentUrl };
      }

      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: currentUrl };
      }

      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (exceeded ${maxRedirects} hops).`);
      }

      let resolvedNext: string;
      try {
        resolvedNext = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`Invalid redirect location: "${location}"`);
      }

      const hopCheck = await validateExternalUrlWithDns(resolvedNext);
      if (!hopCheck.ok) {
        throw new Error(hopCheck.error);
      }
      currentUrl = hopCheck.url.toString();
    }

    throw new Error(`Too many redirects (exceeded ${maxRedirects} hops).`);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abortFromOuter);
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|article|header|footer|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim(),
  );
}

function parseHtmlSnapshot(
  html: string,
  baseUrl: string,
): {
  title: string;
  textSummary: string;
  links: BrowserSnapshotLink[];
  inputs: BrowserSnapshotInput[];
  snapshotTree: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
    : baseUrl;

  const links: BrowserSnapshotLink[] = [];
  const seenHrefs = new Set<string>();
  let refCounter = 1;

  const linkRegex = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch: RegExpExecArray | null = linkRegex.exec(html);
  while (linkMatch && links.length < 40) {
    const rawHref = linkMatch[1]?.trim();
    const text = stripTags(linkMatch[2] ?? '').slice(0, 100);
    if (rawHref && text) {
      try {
        const resolved = new URL(rawHref, baseUrl).toString();
        if (
          (resolved.startsWith('http://') || resolved.startsWith('https://')) &&
          !seenHrefs.has(resolved)
        ) {
          seenHrefs.add(resolved);
          links.push({
            ref: `@e${refCounter++}`,
            text,
            href: resolved,
          });
        }
      } catch {
        // Ignore malformed relative hrefs.
      }
    }
    linkMatch = linkRegex.exec(html);
  }

  const inputs: BrowserSnapshotInput[] = [];
  const inputRegex = /<(input|textarea|button)\b([^>]*)>/gi;
  let inputMatch: RegExpExecArray | null = inputRegex.exec(html);
  while (inputMatch && inputs.length < 25) {
    const tag = inputMatch[1].toLowerCase();
    const attrs = inputMatch[2] ?? '';
    const typeAttr =
      /type=["']([^"']+)["']/i.exec(attrs)?.[1] ?? (tag === 'button' ? 'button' : 'text');
    if (typeAttr === 'hidden') {
      inputMatch = inputRegex.exec(html);
      continue;
    }
    const nameAttr = /name=["']([^"']+)["']/i.exec(attrs)?.[1];
    const placeholderAttr =
      /placeholder=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      /aria-label=["']([^"']+)["']/i.exec(attrs)?.[1];

    inputs.push({
      ref: `@e${refCounter++}`,
      type: tag === 'textarea' ? 'textarea' : typeAttr,
      name: nameAttr,
      placeholder: placeholderAttr ? decodeHtmlEntities(placeholderAttr) : undefined,
    });
    inputMatch = inputRegex.exec(html);
  }

  const textSummary = stripTags(html).slice(0, 8_000);
  const treeLines: string[] = [
    `document "${title}" (${baseUrl})`,
    ...links.slice(0, 25).map((l) => `  - link "${l.text}" [ref=${l.ref}] -> ${l.href}`),
    ...inputs
      .slice(0, 15)
      .map(
        (inp) => `  - ${inp.type} "${inp.placeholder ?? inp.name ?? inp.type}" [ref=${inp.ref}]`,
      ),
  ];

  return {
    title,
    textSummary,
    links,
    inputs,
    snapshotTree: treeLines.join('\n'),
  };
}

function buildSnapshotPreviewSvg(title: string, url: string, textSummary: string): string {
  const esc = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  const lines = textSummary
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((l) => (l.length > 88 ? `${l.slice(0, 87)}…` : l));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#111112"/>
  <rect x="24" y="24" width="912" height="492" rx="16" fill="#1f1f22" stroke="#2f3238" stroke-width="1"/>
  <rect x="24" y="24" width="912" height="44" rx="16" fill="#28292c"/>
  <circle cx="48" cy="46" r="5" fill="#ef4444"/>
  <circle cx="66" cy="46" r="5" fill="#f59e0b"/>
  <circle cx="84" cy="46" r="5" fill="#22c55e"/>
  <text x="112" y="51" fill="#9ca3af" font-family="ui-monospace, Menlo, monospace" font-size="13">${esc(url.slice(0, 84))}</text>
  <text x="52" y="114" fill="#f2f4f6" font-family="system-ui, sans-serif" font-size="22" font-weight="600">${esc(title.slice(0, 64))}</text>
  <text x="52" y="142" fill="#3d87ff" font-family="ui-monospace, Menlo, monospace" font-size="12">Mode D · HTTP Accessibility Snapshot</text>
  ${lines
    .map(
      (line, idx) =>
        `<text x="52" y="${184 + idx * 32}" fill="#d1d5db" font-family="system-ui, sans-serif" font-size="14">${esc(line)}</text>`,
    )
    .join('\n  ')}
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function fetchHttpSnapshot(url: string): Promise<{
  finalUrl: string;
  title: string;
  textSummary: string;
  links: BrowserSnapshotLink[];
  inputs: BrowserSnapshotInput[];
  snapshotTree: string;
  htmlPreview: string;
  screenshotDataUrl: string;
}> {
  const { response, finalUrl } = await safeExternalFetch(url, {
    method: 'GET',
    timeoutMs: 10_000,
    maxRedirects: 5,
    headers: {
      'user-agent': 'Web-ADE/1.0 (Agent Browser Snapshot)',
      accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
    },
  });

  const parsedFinal = new URL(finalUrl);
  const contentType = response.headers.get('content-type') ?? 'text/html';
  const rawText = await readResponseTextBounded(response, 512 * 1024);

  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    const summary = rawText.slice(0, 8_000);
    return {
      finalUrl,
      title: `${parsedFinal.hostname}${parsedFinal.pathname}`,
      textSummary: summary,
      links: [],
      inputs: [],
      snapshotTree: `document "${parsedFinal.hostname}" (${finalUrl})\n  - text "${summary.slice(0, 300)}"`,
      htmlPreview: `<pre style="font-family:monospace;white-space:pre-wrap;padding:16px">${rawText.slice(0, 24_000).replaceAll('<', '&lt;')}</pre>`,
      screenshotDataUrl: buildSnapshotPreviewSvg(parsedFinal.hostname, finalUrl, summary),
    };
  }

  const parsedSnapshot = parseHtmlSnapshot(rawText, finalUrl);
  return {
    finalUrl,
    ...parsedSnapshot,
    htmlPreview: rawText.slice(0, 120_000),
    screenshotDataUrl: buildSnapshotPreviewSvg(
      parsedSnapshot.title,
      finalUrl,
      parsedSnapshot.textSummary,
    ),
  };
}

interface RelayTarget {
  origin: string;
  sessionToken?: string;
  isLoopback: boolean;
}

async function extractRelayTokenFromSessionJson(
  sandbox: { fs: { readFile: (filePath: string, encoding: BufferEncoding) => Promise<string> } },
  rawJson: string,
): Promise<string | undefined> {
  const parsed = JSON.parse(rawJson) as { tokenFile?: string; token?: string };

  if (typeof parsed.tokenFile === 'string' && parsed.tokenFile.trim().length > 0) {
    try {
      const fromFile = (await sandbox.fs.readFile(parsed.tokenFile.trim(), 'utf8')).trim();
      if (/^[0-9a-f]{64}$/.test(fromFile)) {
        return fromFile;
      }
    } catch {
      // Fall back to inline `token` field if present.
    }
  }

  if (typeof parsed.token === 'string' && /^[0-9a-f]{64}$/.test(parsed.token.trim())) {
    return parsed.token.trim();
  }

  return undefined;
}

async function resolveScreenRelayTarget(chatId: string): Promise<RelayTarget | null> {
  const id = normalizeChatId(chatId);
  const cloud = getActiveCloudSandbox(id);

  if (cloud?.relayUrl) {
    let token = cloud.relayToken;
    if (!token) {
      // Read session token strictly server-side from session.json (`tokenFile` -> `token` fallback).
      try {
        const raw = await cloud.sandbox.fs.readFile(
          '/root/.local/state/screen-relay/default/session.json',
          'utf8',
        );
        const extracted = await extractRelayTokenFromSessionJson(cloud.sandbox, raw);
        if (extracted) {
          token = extracted;
          cloud.relayToken = token;
        }
      } catch {
        try {
          const cmd = await cloud.sandbox.runCommand('bash', [
            '-lc',
            'cat "$HOME/.local/state/screen-relay/default/session.json" 2>/dev/null || true',
          ]);
          const out = (await cmd.stdout()).trim();
          if (out) {
            const extracted = await extractRelayTokenFromSessionJson(cloud.sandbox, out);
            if (extracted) {
              token = extracted;
              cloud.relayToken = token;
            }
          }
        } catch {
          // Relay session file not present yet.
        }
      }
    }

    const parsed = new URL(cloud.relayUrl);
    return {
      origin: parsed.origin,
      sessionToken: token,
      isLoopback: parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost',
    };
  }

  const configuredUrl = process.env.SCREEN_RELAY_URL?.trim() || 'http://127.0.0.1:8080';
  try {
    const parsed = new URL(configuredUrl);
    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    // Never probe loopback in production serverless unless explicitly configured via SCREEN_RELAY_URL.
    if (isLoopback && !process.env.SCREEN_RELAY_URL && process.env.VERCEL) {
      return null;
    }
    return {
      origin: parsed.origin,
      sessionToken: process.env.SCREEN_RELAY_TOKEN?.trim() || undefined,
      isLoopback,
    };
  } catch {
    return null;
  }
}

export async function probeScreenRelay(chatId: string): Promise<{
  available: boolean;
  origin?: string;
  capabilities?: Record<string, unknown>;
  reason?: string;
}> {
  const target = await resolveScreenRelayTarget(chatId);
  if (!target) {
    return { available: false, reason: 'No screen-relay host configured or active.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const headers: Record<string, string> = {};
    if (target.sessionToken) {
      headers.authorization = `Bearer ${target.sessionToken}`;
    }
    const res = await fetch(`${target.origin}/capabilities`, {
      cache: 'no-store',
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      return {
        available: false,
        origin: target.origin,
        reason: `screen-relay returned HTTP ${res.status}`,
      };
    }
    const capabilities = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      available: true,
      origin: target.origin,
      capabilities,
    };
  } catch (error) {
    return {
      available: false,
      origin: target.origin,
      reason: error instanceof Error ? error.message : 'screen-relay unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SECURITY INVARIANT:
 * Mints a one-time viewer ticket via `screen-relay@0.1.2`'s `POST /tickets` endpoint
 * (authenticated server-side via `Authorization: Bearer <sessionToken>`), returning ONLY
 * `{ wsUrl, grantToken, authProtocol: 'ticket', role, expiresAt }`.
 * - Interactive control targets `/stream`; view-only watch targets `/stream?view=1`.
 * - The raw 64-hex `screen-relay` session token NEVER leaves the server!
 */
export async function mintRelayGrant(
  chatId: string,
  role: 'watch' | 'control',
  ttlSec = 600,
): Promise<RelayGrantResult> {
  const clampedTtl = Math.min(3600, Math.max(30, Math.round(ttlSec)));
  const target = await resolveScreenRelayTarget(chatId);

  if (!target) {
    return {
      ok: false,
      role,
      error: 'No screen-relay engine active for this session.',
      hint: 'Start a local screen-relay (`npx screen-relay up -d`) or upgrade to a pre-baked Cloud Sandbox snapshot.',
    };
  }

  // Real screen-relay@0.1.2 C++ engine accepts `/stream` (control) or `/stream?view=1` (watch).
  const streamPath = role === 'control' ? '/stream' : '/stream?view=1';
  const wsOrigin = target.origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  const wsUrl = `${wsOrigin}${streamPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (target.sessionToken) {
      headers.authorization = `Bearer ${target.sessionToken}`;
    }

    const ticketRes = await fetch(`${target.origin}/tickets`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers,
    });

    if (ticketRes.ok) {
      const body = (await ticketRes.json().catch(() => ({}))) as {
        ticket?: string;
        token?: string;
        grant?: string;
        grantToken?: string;
        expires_in?: number;
        expiresAt?: string | number;
        expires_at?: string | number;
        ttl?: number;
      };
      const grantToken = body.ticket ?? body.token ?? body.grantToken ?? body.grant;
      if (grantToken && grantToken !== target.sessionToken) {
        const ttlSeconds =
          typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
            ? body.expires_in
            : typeof body.ttl === 'number' && Number.isFinite(body.ttl)
              ? body.ttl
              : clampedTtl;
        const expiresAt =
          typeof body.expiresAt === 'string'
            ? body.expiresAt
            : typeof body.expires_at === 'string'
              ? body.expires_at
              : new Date(Date.now() + ttlSeconds * 1000).toISOString();

        return {
          ok: true,
          wsUrl,
          grantToken,
          authProtocol: 'ticket',
          role,
          expiresAt,
          origin: target.origin,
        };
      }
    }

    // On loopback without a session token, screen-relay accepts unauthenticated local WS viewers.
    if (target.isLoopback && !target.sessionToken) {
      const probe = await probeScreenRelay(chatId);
      if (probe.available) {
        return {
          ok: true,
          wsUrl,
          role,
          origin: target.origin,
          loopbackNoAuth: true,
          expiresAt: new Date(Date.now() + clampedTtl * 1000).toISOString(),
          capabilities: probe.capabilities,
        };
      }
    }

    return {
      ok: false,
      role,
      origin: target.origin,
      error: `Failed to mint one-time ${role} ticket (HTTP ${ticketRes.status}).`,
      hint: 'Ensure screen-relay@0.1.2 is running with a valid server-side session token.',
    };
  } catch (error) {
    return {
      ok: false,
      role,
      origin: target.origin,
      error: error instanceof Error ? error.message : 'Unable to contact screen-relay engine.',
      hint: 'Run `screen-relay up -d` locally or boot a Cloud Sandbox with the desktop snapshot.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function getLocalAgentBrowserStreamUrl(): string | undefined {
  const port = process.env.AGENT_BROWSER_STREAM_PORT?.trim() || '9223';
  if (process.env.VERCEL && !process.env.AGENT_BROWSER_STREAM_URL) {
    return undefined;
  }
  if (process.env.AGENT_BROWSER_STREAM_URL) {
    return process.env.AGENT_BROWSER_STREAM_URL.trim();
  }
  return `ws://127.0.0.1:${port}/?pacing=ack&maxFps=15`;
}

const sandboxStreamInitialized = new Set<string>();

async function tryRunSandboxAgentBrowser(
  chatId: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; streamUrl?: string } | null> {
  const cloud = getActiveCloudSandbox(chatId);
  if (!cloud) return null;

  const sandboxAdapter: VercelSandboxSession = {
    runCommand: (command, cmdArgs) =>
      cloud.sandbox.runCommand({
        cmd: command,
        args: [...cmdArgs],
        env: { AGENT_BROWSER_STREAM_PORT: '4848' },
      }),
    snapshot: async () => {
      const snap = await cloud.sandbox.snapshot();
      return { snapshotId: snap.snapshotId };
    },
    stop: async () => {
      await cloud.sandbox.stop();
    },
  };

  const sessionName = sanitizeSandboxName(chatId);

  try {
    const result = await runAgentBrowserCommand(sandboxAdapter, args, {
      session: sessionName,
    });

    if (!sandboxStreamInitialized.has(cloud.sandboxName)) {
      sandboxStreamInitialized.add(cloud.sandboxName);
      // Enable Mode C WebSocket JPEG streaming on exposed sandbox port 4848 (best-effort).
      void runAgentBrowserCommand(sandboxAdapter, ['stream', 'enable', '--port', '4848'], {
        session: sessionName,
      }).catch(() => undefined);
    }

    const streamUrl = cloud.browserStreamUrl
      ? `${cloud.browserStreamUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/?pacing=ack&maxFps=15`
      : undefined;
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      streamUrl,
    };
  } catch {
    return null;
  }
}

async function tryRunLocalAgentBrowser(
  chatId: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; streamUrl?: string } | null> {
  const installed = await isLocalAgentBrowserInstalled();
  if (!installed) return null;

  try {
    const { stdout, stderr } = await execFileAsync(
      'agent-browser',
      ['--session', sanitizeSandboxName(chatId), ...args],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return {
      ok: true,
      stdout,
      stderr,
      streamUrl: getLocalAgentBrowserStreamUrl(),
    };
  } catch {
    return null;
  }
}

async function getOrCreateRemoteBrowser(
  session: StoredBrowserSession,
): Promise<AgentBrowserSession | null> {
  if (process.env.REMOTE_AGENT_BROWSER_ENABLED !== 'true' || !hasVercelSandboxCredentials()) {
    return null;
  }
  if (!session.remoteSession) {
    try {
      const { AgentBrowser } = await import('remote-agent-browser');
      session.remoteSession = AgentBrowser.session({
        id: `rab-${sanitizeSandboxName(session.chatId)}`,
      });
    } catch {
      return null;
    }
  }
  return session.remoteSession;
}

function toActionResult(
  session: StoredBrowserSession,
  action: string,
  extra?: Partial<BrowserActionResult>,
): BrowserActionResult {
  return {
    ok: true,
    action,
    mode: session.mode,
    backend: session.backend,
    url: session.url,
    title: session.title,
    textSummary: session.textSummary,
    snapshotTree: session.snapshotTree,
    links: session.links,
    inputs: session.inputs,
    htmlPreview: session.htmlPreview,
    screenshotDataUrl: session.lastScreenshotDataUrl,
    streamUrl: session.streamUrl,
    previewUrl: session.previewUrl,
    canGoBack: session.historyIndex > 0,
    canGoForward: session.historyIndex < session.history.length - 1,
    viewport: session.viewport,
    consoleLogs: session.consoleLogs.slice(-20),
    statusMessage: session.statusMessage,
    ...extra,
  };
}

export async function getBrowserStatus(chatId: string): Promise<BrowserStatusPayload> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);
  const cloud = getActiveCloudSandbox(id);
  const files = await getAllFilesRecord(id);
  const [relayProbe, localAb] = await Promise.all([
    probeScreenRelay(id),
    isLocalAgentBrowserInstalled(),
  ]);

  if (cloud?.previewUrl) {
    session.previewUrl = cloud.previewUrl;
  }

  if (session.url === 'workspace://index.html' && files['index.html']) {
    session.htmlPreview = files['index.html'];
  }

  const agentBrowserAvailable = Boolean(cloud?.browserStreamUrl || localAb);
  if (!session.streamUrl && cloud?.browserStreamUrl) {
    session.streamUrl = `${cloud.browserStreamUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/?pacing=ack&maxFps=15`;
  } else if (!session.streamUrl && localAb) {
    session.streamUrl = getLocalAgentBrowserStreamUrl();
  }

  return {
    chatId: id,
    mode: session.mode,
    url: session.url,
    title: session.title,
    isConnected:
      session.mode === 'preview' ||
      session.mode === 'snapshot' ||
      (session.mode === 'screen-relay' && relayProbe.available) ||
      (session.mode === 'agent-browser' && agentBrowserAvailable),
    isHumanInControl: session.isHumanInControl,
    sandboxId: cloud?.sandboxName,
    streamUrl: session.streamUrl,
    previewUrl: session.previewUrl,
    lastScreenshotUrl: session.lastScreenshotDataUrl,
    viewport: session.viewport,
    statusMessage: session.statusMessage,
    canGoBack: session.historyIndex > 0,
    canGoForward: session.historyIndex < session.history.length - 1,
    availableModes: {
      preview: true,
      screenRelay: relayProbe.available,
      agentBrowser: agentBrowserAvailable,
      snapshot: true,
    },
    backend: session.backend,
    snapshotTree: session.snapshotTree,
    textSummary: session.textSummary,
    links: session.links,
    inputs: session.inputs,
    htmlPreview: session.htmlPreview ?? files['index.html'],
    consoleLogs: session.consoleLogs.slice(-30),
  };
}

export async function browserOpen(
  chatId: string,
  rawUrl: string,
  options?: { mode?: BrowserStreamMode; skipHistory?: boolean },
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);
  const trimmed = rawUrl.trim();

  // Workspace HTML preview protocol (zero-latency Mode A)
  if (!trimmed || trimmed === 'workspace://index.html' || trimmed.startsWith('workspace://')) {
    const filePath = trimmed.replace(/^workspace:\/\//, '') || 'index.html';
    const files = await getAllFilesRecord(id);
    const html = files[filePath] ?? files['index.html'] ?? '<h1>No workspace HTML file found.</h1>';
    session.mode = options?.mode ?? 'preview';
    session.backend = 'workspace-preview';
    session.url = `workspace://${filePath}`;
    session.title = `Workspace · ${filePath}`;
    session.htmlPreview = html;
    session.statusMessage = `Rendering ${filePath} in live Preview`;
    if (!options?.skipHistory) pushHistory(session, session.url);
    appendConsoleLog(session, 'info', `Loaded workspace preview: ${filePath}`);
    return toActionResult(session, 'open');
  }

  let validatedUrl: string;
  try {
    validatedUrl = validateExternalUrl(trimmed).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid URL';
    appendConsoleLog(session, 'error', message);
    return toActionResult(session, 'open', { ok: false, error: message });
  }

  // Try Mode C: Sandbox @agent-browser/sandbox/vercel
  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['open', validatedUrl]);
  if (sandboxAb?.ok) {
    session.mode = options?.mode ?? 'agent-browser';
    session.backend = 'agent-browser-sandbox';
    session.url = validatedUrl;
    session.streamUrl = sandboxAb.streamUrl ?? session.streamUrl;
    if (!options?.skipHistory) pushHistory(session, validatedUrl);
    const snap = await tryRunSandboxAgentBrowser(id, ['snapshot', '-i', '-c']);
    session.snapshotTree = snap?.stdout?.trim() || sandboxAb.stdout.trim();
    session.statusMessage = `Navigated via Cloud agent-browser`;
    appendConsoleLog(session, 'info', `agent-browser (sandbox) opened ${validatedUrl}`);
    return toActionResult(session, 'open');
  }

  // Try Mode C: Local agent-browser CLI
  const localAb = await tryRunLocalAgentBrowser(id, ['open', validatedUrl]);
  if (localAb?.ok) {
    session.mode = options?.mode ?? 'agent-browser';
    session.backend = 'agent-browser-local';
    session.url = validatedUrl;
    session.streamUrl = localAb.streamUrl ?? session.streamUrl;
    if (!options?.skipHistory) pushHistory(session, validatedUrl);
    const snap = await tryRunLocalAgentBrowser(id, ['snapshot', '-i', '-c']);
    session.snapshotTree = snap?.stdout?.trim() || localAb.stdout.trim();
    session.statusMessage = `Navigated via local agent-browser`;
    appendConsoleLog(session, 'info', `agent-browser (local) opened ${validatedUrl}`);
    return toActionResult(session, 'open');
  }

  // Try Mode D (Cloud): remote-agent-browser when explicitly enabled
  const remoteBrowser = await getOrCreateRemoteBrowser(session);
  if (remoteBrowser) {
    try {
      const snapRes = await remoteBrowser.snapshot(validatedUrl);
      const output = snapRes.results
        .map((r) => r.stdout)
        .filter(Boolean)
        .join('\n');
      session.mode = options?.mode ?? 'snapshot';
      session.backend = 'remote-agent-browser';
      session.url = validatedUrl;
      session.title = validatedUrl;
      session.snapshotTree = output;
      session.textSummary = output.slice(0, 8_000);
      if (!options?.skipHistory) pushHistory(session, validatedUrl);
      session.statusMessage = 'Captured live Chromium snapshot via remote-agent-browser';
      appendConsoleLog(session, 'info', `remote-agent-browser opened ${validatedUrl}`);
      return toActionResult(session, 'open');
    } catch {
      // Gracefully fall through to universal HTTP snapshot fallback.
    }
  }

  // Mode D (Universal Zero-Config Fallback): Safe server-side HTTP fetch snapshot
  try {
    const snap = await fetchHttpSnapshot(validatedUrl);
    session.mode = options?.mode ?? 'snapshot';
    session.backend = 'http-snapshot';
    session.url = snap.finalUrl;
    session.title = snap.title;
    session.textSummary = snap.textSummary;
    session.links = snap.links;
    session.inputs = snap.inputs;
    session.snapshotTree = snap.snapshotTree;
    session.htmlPreview = snap.htmlPreview;
    session.lastScreenshotDataUrl = snap.screenshotDataUrl;
    if (!options?.skipHistory) pushHistory(session, snap.finalUrl);
    session.statusMessage = `Snapshot loaded (${snap.links.length} links · ${snap.inputs.length} controls)`;
    appendConsoleLog(session, 'info', `Fetched snapshot for ${snap.finalUrl}`);
    return toActionResult(session, 'open');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch URL';
    session.statusMessage = `Navigation error: ${message}`;
    appendConsoleLog(session, 'error', `Failed to open ${validatedUrl}: ${message}`);
    return toActionResult(session, 'open', {
      ok: false,
      error: message,
    });
  }
}

export async function browserBack(chatId: string): Promise<BrowserActionResult> {
  const session = getOrCreateSession(chatId);
  if (session.historyIndex <= 0) {
    return toActionResult(session, 'back', { statusMessage: 'Already at start of history' });
  }
  session.historyIndex -= 1;
  const targetUrl = session.history[session.historyIndex];
  return browserOpen(chatId, targetUrl, { mode: session.mode, skipHistory: true });
}

export async function browserForward(chatId: string): Promise<BrowserActionResult> {
  const session = getOrCreateSession(chatId);
  if (session.historyIndex >= session.history.length - 1) {
    return toActionResult(session, 'forward', { statusMessage: 'Already at latest page' });
  }
  session.historyIndex += 1;
  const targetUrl = session.history[session.historyIndex];
  return browserOpen(chatId, targetUrl, { mode: session.mode, skipHistory: true });
}

export async function browserReload(chatId: string): Promise<BrowserActionResult> {
  const session = getOrCreateSession(chatId);
  return browserOpen(chatId, session.url, { mode: session.mode, skipHistory: true });
}

export async function browserSnapshot(
  chatId: string,
  options?: { interactive?: boolean; compact?: boolean },
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);
  const flags = ['snapshot'];
  if (options?.interactive ?? true) flags.push('-i');
  if (options?.compact ?? true) flags.push('-c');

  const sandboxAb = await tryRunSandboxAgentBrowser(id, flags);
  if (sandboxAb?.ok) {
    session.snapshotTree = sandboxAb.stdout.trim();
    session.statusMessage = 'Updated accessibility snapshot (sandbox)';
    return toActionResult(session, 'snapshot');
  }

  const localAb = await tryRunLocalAgentBrowser(id, flags);
  if (localAb?.ok) {
    session.snapshotTree = localAb.stdout.trim();
    session.statusMessage = 'Updated accessibility snapshot (local)';
    return toActionResult(session, 'snapshot');
  }

  if (!session.snapshotTree && session.url.startsWith('http')) {
    return browserOpen(id, session.url, { mode: session.mode, skipHistory: true });
  }

  if (session.url.startsWith('workspace://')) {
    const relPath = session.url.replace(/^workspace:\/\//, '').trim() || 'index.html';
    const files = await getAllFilesRecord(id);
    const html = files[relPath] ?? files['index.html'] ?? '';
    const parsed = parseHtmlSnapshot(html, session.url);
    session.title = parsed.title;
    session.textSummary = parsed.textSummary;
    session.links = parsed.links;
    session.inputs = parsed.inputs;
    session.snapshotTree = parsed.snapshotTree;
    session.htmlPreview = html;
  }

  return toActionResult(session, 'snapshot');
}

export async function browserScreenshot(
  chatId: string,
  options?: { fullPage?: boolean },
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  // If screen-relay is reachable, fetch a live PNG screenshot server-side.
  const relay = await resolveScreenRelayTarget(id);
  if (relay) {
    try {
      const headers: Record<string, string> = {};
      if (relay.sessionToken) {
        headers.authorization = `Bearer ${relay.sessionToken}`;
      }
      const res = await fetch(`${relay.origin}/screenshot.png`, {
        cache: 'no-store',
        headers,
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        session.lastScreenshotDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        session.statusMessage = 'Captured live screen-relay PNG screenshot';
        return toActionResult(session, 'screenshot');
      }
    } catch {
      // Fall through to other capture tiers.
    }
  }

  // Try remote-agent-browser screenshot if active.
  const remoteBrowser = await getOrCreateRemoteBrowser(session);
  if (remoteBrowser && session.url.startsWith('http')) {
    try {
      const res = await remoteBrowser.screenshot(session.url, { fullPage: options?.fullPage });
      session.lastScreenshotDataUrl = `data:image/png;base64,${res.png.toString('base64')}`;
      session.statusMessage = 'Captured Chromium PNG screenshot';
      return toActionResult(session, 'screenshot');
    } catch {
      // Fall through to SVG snapshot fallback.
    }
  }

  if (!session.lastScreenshotDataUrl) {
    session.lastScreenshotDataUrl = buildSnapshotPreviewSvg(
      session.title || session.url,
      session.url,
      session.textSummary || 'Interactive preview ready.',
    );
  }
  session.statusMessage = 'Rendered snapshot preview frame';
  return toActionResult(session, 'screenshot');
}

export async function browserClick(
  chatId: string,
  target: string | { x: number; y: number },
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  if (typeof target === 'string') {
    const sandboxAb = await tryRunSandboxAgentBrowser(id, ['click', target]);
    if (sandboxAb?.ok) {
      appendConsoleLog(session, 'info', `Clicked ${target} (sandbox)`);
      return browserSnapshot(id);
    }

    const localAb = await tryRunLocalAgentBrowser(id, ['click', target]);
    if (localAb?.ok) {
      appendConsoleLog(session, 'info', `Clicked ${target} (local)`);
      return browserSnapshot(id);
    }

    // Mode D fallback: resolve @eN ref or link text and navigate to link target!
    const matchedLink = session.links.find(
      (link) =>
        link.ref === target ||
        link.href === target ||
        link.text.toLowerCase().includes(target.toLowerCase()),
    );
    if (matchedLink) {
      appendConsoleLog(
        session,
        'info',
        `Clicked ${matchedLink.ref} ("${matchedLink.text}") -> ${matchedLink.href}`,
      );
      return browserOpen(id, matchedLink.href, { mode: session.mode });
    }

    appendConsoleLog(session, 'warn', `Click target "${target}" recorded in snapshot mode`);
    return toActionResult(session, 'click', {
      statusMessage: `Target "${target}" not linked in static snapshot; upgrade to Cloud Sandbox for full DOM click execution.`,
    });
  }

  appendConsoleLog(
    session,
    'info',
    `Pointer click at (${Math.round(target.x)}, ${Math.round(target.y)})`,
  );
  return toActionResult(session, 'click', {
    statusMessage: `Recorded click at (${Math.round(target.x)}, ${Math.round(target.y)})`,
  });
}

export async function browserFill(
  chatId: string,
  selector: string,
  value: string,
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['fill', selector, value]);
  if (sandboxAb?.ok) {
    appendConsoleLog(session, 'info', `Filled ${selector}`);
    return browserSnapshot(id);
  }

  const localAb = await tryRunLocalAgentBrowser(id, ['fill', selector, value]);
  if (localAb?.ok) {
    appendConsoleLog(session, 'info', `Filled ${selector}`);
    return browserSnapshot(id);
  }

  const input = session.inputs.find((item) => item.ref === selector || item.name === selector);
  if (input) {
    input.value = value;
  }
  appendConsoleLog(session, 'info', `Set ${selector} = "${value.slice(0, 60)}"`);
  return toActionResult(session, 'fill', {
    statusMessage: `Updated ${selector} in current browser state`,
  });
}

export async function browserType(
  chatId: string,
  text: string,
  selector?: string,
): Promise<BrowserActionResult> {
  if (selector) {
    return browserFill(chatId, selector, text);
  }
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['type', text]);
  if (sandboxAb?.ok) {
    appendConsoleLog(session, 'info', `Typed text into active element`);
    return browserSnapshot(id);
  }

  const localAb = await tryRunLocalAgentBrowser(id, ['type', text]);
  if (localAb?.ok) {
    appendConsoleLog(session, 'info', `Typed text into active element`);
    return browserSnapshot(id);
  }

  appendConsoleLog(session, 'info', `Typed "${text.slice(0, 60)}"`);
  return toActionResult(session, 'type', {
    statusMessage: `Typed text into browser session`,
  });
}

export async function browserPress(chatId: string, key: string): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['press', key]);
  if (sandboxAb?.ok) {
    appendConsoleLog(session, 'info', `Pressed key ${key}`);
    return browserSnapshot(id);
  }

  const localAb = await tryRunLocalAgentBrowser(id, ['press', key]);
  if (localAb?.ok) {
    appendConsoleLog(session, 'info', `Pressed key ${key}`);
    return browserSnapshot(id);
  }

  appendConsoleLog(session, 'info', `Key press "${key}" recorded`);
  return toActionResult(session, 'press', {
    statusMessage: `Sent key "${key}"`,
  });
}

export async function browserScroll(
  chatId: string,
  direction: 'up' | 'down' | 'left' | 'right' = 'down',
  amount = 480,
): Promise<BrowserActionResult> {
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['scroll', direction, String(amount)]);
  if (sandboxAb?.ok) {
    return browserSnapshot(id);
  }

  const localAb = await tryRunLocalAgentBrowser(id, ['scroll', direction, String(amount)]);
  if (localAb?.ok) {
    return browserSnapshot(id);
  }

  appendConsoleLog(session, 'info', `Scrolled ${direction} by ${amount}px`);
  return toActionResult(session, 'scroll', {
    statusMessage: `Scrolled ${direction} (${amount}px)`,
  });
}

export async function browserRead(chatId: string, url?: string): Promise<BrowserActionResult> {
  if (url) {
    return browserOpen(chatId, url, { mode: 'snapshot' });
  }
  const id = normalizeChatId(chatId);
  const session = getOrCreateSession(id);

  const sandboxAb = await tryRunSandboxAgentBrowser(id, ['read']);
  if (sandboxAb?.ok) {
    session.textSummary = sandboxAb.stdout.slice(0, 8_000);
    return toActionResult(session, 'read');
  }

  const localAb = await tryRunLocalAgentBrowser(id, ['read']);
  if (localAb?.ok) {
    session.textSummary = localAb.stdout.slice(0, 8_000);
    return toActionResult(session, 'read');
  }

  return browserSnapshot(id);
}

export function setBrowserModeAndViewport(
  chatId: string,
  updates: {
    mode?: BrowserStreamMode;
    viewport?: BrowserViewport;
    isHumanInControl?: boolean;
  },
): BrowserControlState {
  const session = getOrCreateSession(chatId);
  if (updates.mode) session.mode = updates.mode;
  if (updates.viewport) session.viewport = updates.viewport;
  if (typeof updates.isHumanInControl === 'boolean') {
    session.isHumanInControl = updates.isHumanInControl;
  }
  return {
    mode: session.mode,
    url: session.url,
    title: session.title,
    isConnected: true,
    isHumanInControl: session.isHumanInControl,
    streamUrl: session.streamUrl,
    previewUrl: session.previewUrl,
    lastScreenshotUrl: session.lastScreenshotDataUrl,
    viewport: session.viewport,
    statusMessage: session.statusMessage,
  };
}
