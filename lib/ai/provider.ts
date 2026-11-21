import { createGateway, type GatewayProvider, gateway } from '@ai-sdk/gateway';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { metric } from '@vercel/functions';
import { getVercelOidcToken } from '@vercel/functions/oidc';
import type { ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from 'ai';
import {
  checkVercelGatewayCredits,
  type RefreshedVercelOAuthToken,
  refreshVercelOAuthToken,
  type VercelGatewayCreditsResult,
} from '@/lib/ai/credits';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  DEFAULT_SPONSORED_MODEL_ID,
  DEFAULT_SPONSORED_OPENAI_MODEL_ID,
  FAST_MODEL_ID,
  FAST_OPENAI_MODEL_ID,
  IMAGE_OPENAI_MODEL_ID,
  isAnthropicModelId,
  isOpenAIModelId,
  resolveAllowedProviderModelId,
  resolveSponsoredModelId,
  SPONSORED_MODEL_IDS,
  STT_MODEL_ID,
  stripProviderPrefix,
  TTS_MODEL_ID,
  toGatewayRealtimeModelId,
  toOpenAIDirectModelId,
  toOpenAIDirectRealtimeModelId,
} from '@/lib/ai/models';
import type { BillingSource, BillingSourceInfo, ProviderOverrideConfig } from '@/lib/types';

const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1_000;
const GATEWAY_OPENAI_COMPAT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

export interface UserVercelAuth {
  accessToken: string;
  refreshToken?: string;
  /** Token expiration timestamp (epoch ms, epoch seconds, ISO string, or Date). */
  expiresAt?: number | string | Date | null;
  teamIdOrSlug?: string;
  /** Better Auth OAuth provider ID (`'vercel'` or `'vercel-connect'`). */
  providerId?: string;
  onRefreshed?: (tokens: RefreshedVercelOAuthToken) => Promise<void> | void;
}

/**
 * Superset of `ProviderOverrideConfig` supporting both canonical `lib/types.ts`
 * fields (`mode`, `baseUrl`, `apiKey`, `model`) and flat UI settings aliases
 * (`customBaseUrl`, `customApiKey`, `customModel`, `byokApiKey`).
 */
export interface ProviderOverrideInput extends ProviderOverrideConfig {
  customBaseUrl?: string;
  customApiKey?: string;
  customModel?: string;
  byokApiKey?: string;
  teamIdOrSlug?: string;
}

export interface ResolveProviderOptions {
  /** Requested model ID. Omit to pick the primary default for the active tier. */
  modelId?: string;
  override?: ProviderOverrideInput | null;
  userVercelAuth?: UserVercelAuth | null;
  /** Skip Tier 2b signed-in Vercel OAuth token (used on retry after 401/402/403). */
  skipUserToken?: boolean;
}

export interface ResolvedLanguageModel {
  model: LanguageModel;
  modelId: string;
  requestedModelId: string;
  billingSource: BillingSource;
  billingInfo: BillingSourceInfo;
  fallbackReason?: string;
  creditsRemaining?: number | null;
}

export type ResolvedImageGenerator =
  | {
      kind: 'language-files';
      model: LanguageModel;
      modelId: string;
      billingSource: BillingSource;
      billingInfo: BillingSourceInfo;
      fallbackReason?: string;
    }
  | {
      kind: 'image-model';
      model: ImageModel;
      modelId: string;
      billingSource: BillingSource;
      billingInfo: BillingSourceInfo;
      fallbackReason?: string;
    };

export interface ResolvedTranscriptionModel {
  model: TranscriptionModel;
  modelId: string;
  billingSource: BillingSource;
  billingInfo: BillingSourceInfo;
  fallbackReason?: string;
}

export interface ResolvedSpeechModel {
  model: SpeechModel;
  modelId: string;
  billingSource: BillingSource;
  billingInfo: BillingSourceInfo;
  fallbackReason?: string;
}

export interface ResolvedRealtimeTokenResult {
  token: string;
  url: string;
  expiresAt?: number;
}

export interface ResolvedRealtimeTokenConfig {
  supported: boolean;
  transport: 'gateway' | 'openai' | 'unsupported';
  modelId: string;
  billingSource: BillingSource;
  billingInfo: BillingSourceInfo;
  fallbackReason?: string;
  reason?: string;
  /** Server-only helper that mints an ephemeral client secret without leaking credentials. */
  mintToken?: (options?: { expiresAfterSeconds?: number }) => Promise<ResolvedRealtimeTokenResult>;
}

export interface ResolvedFxCredentials {
  mode: 'gateway' | 'openai' | 'custom';
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  headers: Record<string, string>;
  billingSource: BillingSource;
  billingInfo: BillingSourceInfo;
  fallbackReason?: string;
  /** Pre-built custom `fetch` wrapper injecting resolved auth & headers per turn. */
  createFetch: () => typeof fetch;
}

export interface ProviderTierStatus {
  tier: 1 | 2 | 3 | 4 | 5;
  id:
    | 'custom-endpoint'
    | 'user-byok'
    | 'user-vercel-oauth'
    | 'sponsor-openai'
    | 'sponsor-gateway'
    | 'vercel-oidc';
  label: string;
  configured: boolean;
  active: boolean;
  detail?: string;
}

export interface ProviderDiagnostics {
  activeBillingSource: BillingSource;
  activeBillingInfo: BillingSourceInfo;
  defaultModelId: string;
  /** True when active billing is host-sponsored and restricted to Claude Haiku 5.5 + GPT-6 Luna. */
  sponsoredOnlyModels: boolean;
  sponsoredModelIds: readonly string[];
  fallbackReason?: string;
  vercelOAuthConfigured: boolean;
  vercelConnectConfigured: boolean;
  hasCustomEnv: boolean;
  hasCustomOverride: boolean;
  hasByokOverride: boolean;
  hasUserVercelAuth: boolean;
  hasOpenAIKey: boolean;
  hasGatewayKey: boolean;
  hasOidcToken: boolean;
  userCredits?: {
    checked: boolean;
    ok: boolean;
    balance?: number;
    totalUsed?: number;
    status?: number;
    reason?: string;
  };
  tiers: ProviderTierStatus[];
}

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  readonly billingSource: BillingSource = 'unconfigured';

  constructor(message?: string) {
    super(
      message ??
        'No AI provider is configured. Add a custom endpoint or BYOK key in Settings, sign in with Vercel, or configure OPENAI_API_KEY / AI_GATEWAY_API_KEY / Vercel OIDC.',
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderCapabilityError extends Error {
  readonly code = 'PROVIDER_CAPABILITY_UNSUPPORTED';
  readonly billingSource: BillingSource;

  constructor(billingSource: BillingSource, message: string) {
    super(message);
    this.name = 'ProviderCapabilityError';
    this.billingSource = billingSource;
  }
}

function trimNonEmpty(value?: string | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHttpBaseUrl(rawUrl?: string | null): string | undefined {
  const trimmed = trimNonEmpty(rawUrl);
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return trimmed.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Custom Endpoint';
  }
}

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.trim();
    const lower = k.toLowerCase();
    if (!k || lower === 'host' || lower === 'content-length' || typeof value !== 'string') {
      continue;
    }
    clean[k] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function normalizeExpiresAtMs(expiresAt?: number | string | Date | null): number | undefined {
  if (expiresAt === null || expiresAt === undefined) {
    return undefined;
  }
  if (expiresAt instanceof Date) {
    const ms = expiresAt.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    // Normalize Unix epoch seconds vs milliseconds.
    return expiresAt < 1_000_000_000_000 ? expiresAt * 1_000 : expiresAt;
  }
  return undefined;
}

function emitProviderMetric(billingSource: BillingSource): void {
  try {
    metric('ade.provider.resolved', 1, { billing_source: billingSource });
  } catch {
    // Metrics are best-effort and must never fail provider resolution.
  }
}

interface ParsedOverride {
  mode: NonNullable<ProviderOverrideConfig['mode']>;
  customBaseUrl?: string;
  customApiKey?: string;
  customModel?: string;
  byokApiKey?: string;
  byokKind?: 'gateway' | 'openai';
  headers?: Record<string, string>;
  teamIdOrSlug?: string;
}

function parseOverride(override?: ProviderOverrideInput | null): ParsedOverride {
  const mode = override?.mode ?? 'auto';
  const explicitCustomUrl = normalizeHttpBaseUrl(override?.customBaseUrl);
  const genericBaseUrl = normalizeHttpBaseUrl(override?.baseUrl);
  const explicitByokKey = trimNonEmpty(override?.byokApiKey);
  const genericApiKey = trimNonEmpty(override?.apiKey);
  const explicitCustomKey = trimNonEmpty(override?.customApiKey);
  const explicitCustomModel = trimNonEmpty(override?.customModel);
  const genericModel = trimNonEmpty(override?.model);
  const headers = sanitizeHeaders(override?.headers);
  const teamIdOrSlug = trimNonEmpty(override?.teamIdOrSlug);

  // Determine Tier 1 UI custom endpoint override.
  let customBaseUrl: string | undefined;
  let customApiKey: string | undefined;
  let customModel: string | undefined;

  if (mode === 'custom-openai-compatible') {
    customBaseUrl = explicitCustomUrl ?? genericBaseUrl;
    customApiKey = explicitCustomKey ?? genericApiKey;
    customModel = explicitCustomModel ?? genericModel;
  } else if (mode === 'auto') {
    customBaseUrl = explicitCustomUrl ?? genericBaseUrl;
    if (customBaseUrl) {
      customApiKey = explicitCustomKey ?? (!explicitByokKey ? genericApiKey : undefined);
      customModel = explicitCustomModel ?? genericModel;
    }
  }

  // Determine Tier 2a BYOK API key override.
  let byokApiKey: string | undefined;
  let byokKind: 'gateway' | 'openai' | undefined;

  if (mode === 'byok-gateway') {
    byokApiKey = explicitByokKey ?? genericApiKey;
    if (byokApiKey) {
      byokKind = 'gateway';
    }
  } else if (mode === 'byok-openai') {
    byokApiKey = explicitByokKey ?? genericApiKey;
    if (byokApiKey) {
      byokKind = 'openai';
    }
  } else if (!customBaseUrl) {
    byokApiKey = explicitByokKey ?? genericApiKey;
    if (byokApiKey) {
      byokKind = byokApiKey.startsWith('vck_') ? 'gateway' : 'openai';
    }
  }

  return {
    mode,
    customBaseUrl,
    customApiKey,
    customModel,
    byokApiKey,
    byokKind,
    headers,
    teamIdOrSlug,
  };
}

interface EnvCredentials {
  customBaseUrl?: string;
  customApiKey?: string;
  customModel?: string;
  openAIKey?: string;
  gatewayKey?: string;
  oidcToken?: string;
  hasOidcRuntime: boolean;
  vercelOAuthConfigured: boolean;
  vercelConnectConfigured: boolean;
}

function readEnvCredentials(): EnvCredentials {
  const customBaseUrl = normalizeHttpBaseUrl(process.env.OPENAI_COMPATIBLE_BASE_URL);
  const customApiKey = trimNonEmpty(process.env.OPENAI_COMPATIBLE_API_KEY);
  const customModel = trimNonEmpty(process.env.OPENAI_COMPATIBLE_MODEL);
  const openAIKey = trimNonEmpty(process.env.OPENAI_API_KEY);
  const gatewayKey = trimNonEmpty(process.env.AI_GATEWAY_API_KEY);
  const oidcToken = trimNonEmpty(process.env.VERCEL_OIDC_TOKEN);
  const hasOidcRuntime = Boolean(oidcToken || process.env.VERCEL === '1');
  const vercelOAuthConfigured = Boolean(
    trimNonEmpty(process.env.VERCEL_CLIENT_ID) && trimNonEmpty(process.env.VERCEL_CLIENT_SECRET),
  );
  const vercelConnectConfigured = Boolean(trimNonEmpty(process.env.VERCEL_CONNECT_VERCEL_UID));

  return {
    customBaseUrl,
    customApiKey,
    customModel,
    openAIKey,
    gatewayKey,
    oidcToken,
    hasOidcRuntime,
    vercelOAuthConfigured,
    vercelConnectConfigured,
  };
}

export function getBillingSourceInfo(
  source: BillingSource,
  options?: {
    providerName?: string;
    creditsRemaining?: number | null;
    detail?: string;
  },
): BillingSourceInfo {
  switch (source) {
    case 'custom-endpoint':
      return {
        source,
        label: 'Custom Endpoint',
        providerName: options?.providerName ?? 'OpenAI-Compatible Endpoint',
        isUserBilled: true,
        detail: options?.detail,
      };
    case 'user-byok-gateway':
      return {
        source,
        label: 'Your AI Gateway Key',
        providerName: options?.providerName ?? 'Vercel AI Gateway (BYOK)',
        isUserBilled: true,
        detail: options?.detail,
      };
    case 'user-byok-openai':
      return {
        source,
        label: 'Your OpenAI Key',
        providerName: options?.providerName ?? 'OpenAI (BYOK)',
        isUserBilled: true,
        detail: options?.detail,
      };
    case 'user-vercel-oauth':
      return {
        source,
        label: 'Your Vercel Credits',
        providerName: options?.providerName ?? 'Vercel AI Gateway (Your Account)',
        isUserBilled: true,
        creditsRemaining: options?.creditsRemaining ?? null,
        detail: options?.detail,
      };
    case 'sponsor-openai':
      return {
        source,
        label: 'Demo Sponsored (OpenAI)',
        providerName: options?.providerName ?? 'OpenAI (Host Sponsor)',
        isUserBilled: false,
        detail: options?.detail,
      };
    case 'sponsor-gateway':
      return {
        source,
        label: 'Demo Sponsored (Gateway)',
        providerName: options?.providerName ?? 'Vercel AI Gateway (Host Sponsor)',
        isUserBilled: false,
        detail: options?.detail,
      };
    case 'vercel-oidc':
      return {
        source,
        label: 'Vercel Project OIDC',
        providerName: options?.providerName ?? 'Vercel AI Gateway (Project OIDC)',
        isUserBilled: false,
        detail: options?.detail,
      };
    case 'unconfigured':
      return {
        source,
        label: 'Not Configured',
        providerName: options?.providerName ?? 'No Provider Configured',
        isUserBilled: false,
        detail: options?.detail,
      };
  }
}

interface ActiveUserOAuthResolution {
  usable: boolean;
  accessToken?: string;
  credits?: VercelGatewayCreditsResult;
  fallbackReason?: string;
}

async function resolveUserVercelOAuthToken(
  userVercelAuth?: UserVercelAuth | null,
  teamIdOrSlug?: string,
): Promise<ActiveUserOAuthResolution> {
  if (!userVercelAuth) {
    return { usable: false };
  }

  let accessToken = trimNonEmpty(userVercelAuth.accessToken);
  if (!accessToken) {
    return { usable: false };
  }

  const refreshToken = trimNonEmpty(userVercelAuth.refreshToken);
  let didRefresh = false;

  const tryRefreshToken = async (): Promise<boolean> => {
    if (!refreshToken || didRefresh) {
      return false;
    }
    didRefresh = true;
    const refreshed = await refreshVercelOAuthToken(refreshToken, {
      providerId: userVercelAuth.providerId,
    });
    if (!refreshed?.accessToken) {
      return false;
    }
    accessToken = refreshed.accessToken;
    if (userVercelAuth.onRefreshed) {
      try {
        await userVercelAuth.onRefreshed(refreshed);
      } catch {
        // Best-effort token persistence; continue with the refreshed token for this turn.
      }
    }
    return true;
  };

  const expiresAtMs = normalizeExpiresAtMs(userVercelAuth.expiresAt);
  const isNearExpiry =
    expiresAtMs !== undefined && expiresAtMs - Date.now() <= TOKEN_REFRESH_BUFFER_MS;

  if (isNearExpiry && refreshToken) {
    await tryRefreshToken();
  }

  const effectiveTeam = trimNonEmpty(userVercelAuth.teamIdOrSlug) ?? teamIdOrSlug;
  let credits = await checkVercelGatewayCredits(accessToken, { teamIdOrSlug: effectiveTeam });

  // Reactive refresh if an expired/skewed token yields HTTP 401 before falling back to Tier 3+.
  if (!credits.ok && credits.status === 401 && !didRefresh && refreshToken) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      credits = await checkVercelGatewayCredits(accessToken, {
        teamIdOrSlug: effectiveTeam,
        bypassCache: true,
      });
    }
  }

  if (!credits.ok) {
    return {
      usable: false,
      credits,
      fallbackReason:
        credits.reason ?? 'Signed-in Vercel token could not access AI Gateway — falling back.',
    };
  }

  if (credits.balance !== undefined && credits.balance <= 0) {
    return {
      usable: false,
      credits,
      fallbackReason: 'Signed-in Vercel AI Gateway credit balance is $0 — falling back to sponsor.',
    };
  }

  return {
    usable: true,
    accessToken,
    credits,
  };
}

type InternalResolvedBackend =
  | {
      kind: 'custom';
      baseUrl: string;
      apiKey?: string;
      modelId: string;
      headers?: Record<string, string>;
      billingSource: 'custom-endpoint';
      billingInfo: BillingSourceInfo;
      fallbackReason?: string;
    }
  | {
      kind: 'openai';
      provider: OpenAIProvider;
      apiKey: string;
      modelId: string;
      headers?: Record<string, string>;
      billingSource: 'user-byok-openai' | 'sponsor-openai';
      billingInfo: BillingSourceInfo;
      fallbackReason?: string;
    }
  | {
      kind: 'gateway';
      provider: GatewayProvider;
      /** Defined for BYOK / OAuth / AI_GATEWAY_API_KEY; undefined for OIDC (resolved dynamically). */
      apiKey?: string;
      teamIdOrSlug?: string;
      modelId: string;
      headers?: Record<string, string>;
      billingSource: 'user-byok-gateway' | 'user-vercel-oauth' | 'sponsor-gateway' | 'vercel-oidc';
      billingInfo: BillingSourceInfo;
      fallbackReason?: string;
      creditsRemaining?: number | null;
    };

async function resolveBackend(
  opts: ResolveProviderOptions & { allowCustom?: boolean; defaultModelOverride?: string } = {},
): Promise<InternalResolvedBackend> {
  const allowCustom = opts.allowCustom ?? true;
  const explicitModelId = trimNonEmpty(opts.modelId);
  const parsed = parseOverride(opts.override);
  const env = readEnvCredentials();
  const hasGatewayHostFallback = Boolean(env.gatewayKey || env.hasOidcRuntime);

  const fallbackNotes: string[] = [];

  // -------------------------------------------------------------------------
  // Tier 1a — Explicit User Custom OpenAI-Compatible Endpoint (UI override)
  // -------------------------------------------------------------------------
  if (allowCustom && parsed.customBaseUrl) {
    const customModel =
      parsed.customModel ?? explicitModelId ?? opts.defaultModelOverride ?? DEFAULT_MODEL_ID;

    return {
      kind: 'custom',
      baseUrl: parsed.customBaseUrl,
      apiKey: parsed.customApiKey,
      modelId: customModel,
      headers: parsed.headers,
      billingSource: 'custom-endpoint',
      billingInfo: getBillingSourceInfo('custom-endpoint', {
        providerName: safeHostLabel(parsed.customBaseUrl),
        detail: customModel,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Tier 2a — User BYOK API Key (`vck_*` -> AI Gateway, otherwise OpenAI)
  // Beats host env `OPENAI_COMPATIBLE_BASE_URL` so user keys are never silently overridden.
  // -------------------------------------------------------------------------
  if (parsed.byokApiKey && parsed.byokKind) {
    if (parsed.byokKind === 'gateway') {
      const allowed = resolveAllowedProviderModelId(
        explicitModelId ?? opts.defaultModelOverride ?? DEFAULT_MODEL_ID,
        DEFAULT_MODEL_ID,
      );
      if (allowed.reason) {
        fallbackNotes.push(allowed.reason);
      }
      return {
        kind: 'gateway',
        provider: createGateway({
          apiKey: parsed.byokApiKey,
          teamIdOrSlug: parsed.teamIdOrSlug,
          headers: parsed.headers,
        }),
        apiKey: parsed.byokApiKey,
        teamIdOrSlug: parsed.teamIdOrSlug,
        modelId: allowed.modelId,
        headers: parsed.headers,
        billingSource: 'user-byok-gateway',
        billingInfo: getBillingSourceInfo('user-byok-gateway', { detail: allowed.modelId }),
        fallbackReason: fallbackNotes.join(' ') || undefined,
      };
    }

    const requested = explicitModelId ?? opts.defaultModelOverride ?? DEFAULT_OPENAI_MODEL_ID;
    const directModelId = toOpenAIDirectModelId(requested);
    if (explicitModelId && !isOpenAIModelId(explicitModelId)) {
      fallbackNotes.push(
        `Mapped ${explicitModelId} to ${directModelId} for your direct OpenAI API key.`,
      );
    }

    return {
      kind: 'openai',
      provider: createOpenAI({
        apiKey: parsed.byokApiKey,
        headers: parsed.headers,
      }),
      apiKey: parsed.byokApiKey,
      modelId: directModelId,
      headers: parsed.headers,
      billingSource: 'user-byok-openai',
      billingInfo: getBillingSourceInfo('user-byok-openai', { detail: directModelId }),
      fallbackReason: fallbackNotes.join(' ') || undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Tier 1b — Host Env Custom OpenAI-Compatible Endpoint (`OPENAI_COMPATIBLE_BASE_URL`)
  // -------------------------------------------------------------------------
  const isExplicitByokMode = parsed.mode === 'byok-gateway' || parsed.mode === 'byok-openai';
  if (allowCustom && !isExplicitByokMode && env.customBaseUrl) {
    const customModel =
      parsed.customModel ??
      env.customModel ??
      explicitModelId ??
      opts.defaultModelOverride ??
      DEFAULT_MODEL_ID;

    return {
      kind: 'custom',
      baseUrl: env.customBaseUrl,
      apiKey: parsed.customApiKey ?? env.customApiKey,
      modelId: customModel,
      headers: parsed.headers,
      billingSource: 'custom-endpoint',
      billingInfo: getBillingSourceInfo('custom-endpoint', {
        providerName: safeHostLabel(env.customBaseUrl),
        detail: customModel,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Tier 2b — Signed-in Vercel User OAuth Token (`vca_*`) with Credit Check
  // -------------------------------------------------------------------------
  if (!opts.skipUserToken && opts.userVercelAuth?.accessToken) {
    const userOAuth = await resolveUserVercelOAuthToken(opts.userVercelAuth, parsed.teamIdOrSlug);
    if (userOAuth.usable && userOAuth.accessToken) {
      const allowed = resolveAllowedProviderModelId(
        explicitModelId ?? opts.defaultModelOverride ?? DEFAULT_MODEL_ID,
        DEFAULT_MODEL_ID,
      );
      if (allowed.reason) {
        fallbackNotes.push(allowed.reason);
      }
      const effectiveTeam = trimNonEmpty(opts.userVercelAuth.teamIdOrSlug) ?? parsed.teamIdOrSlug;
      const balance = userOAuth.credits?.balance ?? null;

      return {
        kind: 'gateway',
        provider: createGateway({
          apiKey: userOAuth.accessToken,
          teamIdOrSlug: effectiveTeam,
          headers: parsed.headers,
        }),
        apiKey: userOAuth.accessToken,
        teamIdOrSlug: effectiveTeam,
        modelId: allowed.modelId,
        headers: parsed.headers,
        billingSource: 'user-vercel-oauth',
        billingInfo: getBillingSourceInfo('user-vercel-oauth', {
          creditsRemaining: balance,
          detail: allowed.modelId,
        }),
        fallbackReason: fallbackNotes.join(' ') || undefined,
        creditsRemaining: balance,
      };
    }

    if (userOAuth.fallbackReason) {
      fallbackNotes.push(userOAuth.fallbackReason);
    }
  }

  // -------------------------------------------------------------------------
  // Tier 3 — Host Sponsor `OPENAI_API_KEY` FIRST (strictly GPT-6 Luna unless
  // routing Anthropic requests to sponsored Gateway Claude Haiku 5.5)
  // -------------------------------------------------------------------------
  if (env.openAIKey) {
    const wantsAnthropic = Boolean(explicitModelId && isAnthropicModelId(explicitModelId));
    if (!wantsAnthropic || !hasGatewayHostFallback) {
      const sponsored = resolveSponsoredModelId(explicitModelId, { openaiOnly: true });
      const directModelId = stripProviderPrefix(sponsored.modelId);

      if (sponsored.reason) {
        fallbackNotes.push(sponsored.reason);
      }

      return {
        kind: 'openai',
        provider: createOpenAI({ apiKey: env.openAIKey }),
        apiKey: env.openAIKey,
        modelId: directModelId,
        billingSource: 'sponsor-openai',
        billingInfo: getBillingSourceInfo('sponsor-openai', { detail: directModelId }),
        fallbackReason: fallbackNotes.join(' ') || undefined,
      };
    }

    fallbackNotes.push(
      `Routed Anthropic request via AI Gateway (host OPENAI_API_KEY remains primary for OpenAI models).`,
    );
  }

  // -------------------------------------------------------------------------
  // Tier 4 — Host Sponsor `AI_GATEWAY_API_KEY` (strictly Haiku 5.5 + GPT-6 Luna)
  // -------------------------------------------------------------------------
  if (env.gatewayKey) {
    const sponsored = resolveSponsoredModelId(explicitModelId ?? opts.defaultModelOverride);
    if (sponsored.reason) {
      fallbackNotes.push(sponsored.reason);
    }
    return {
      kind: 'gateway',
      provider: createGateway({ apiKey: env.gatewayKey }),
      apiKey: env.gatewayKey,
      modelId: sponsored.modelId,
      billingSource: 'sponsor-gateway',
      billingInfo: getBillingSourceInfo('sponsor-gateway', { detail: sponsored.modelId }),
      fallbackReason: fallbackNotes.join(' ') || undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Tier 5 — Vercel Project OIDC (`VERCEL_OIDC_TOKEN`) (strictly Haiku 5.5 + GPT-6 Luna)
  // -------------------------------------------------------------------------
  if (env.hasOidcRuntime) {
    const sponsored = resolveSponsoredModelId(explicitModelId ?? opts.defaultModelOverride);
    if (sponsored.reason) {
      fallbackNotes.push(sponsored.reason);
    }
    return {
      kind: 'gateway',
      provider: gateway,
      modelId: sponsored.modelId,
      billingSource: 'vercel-oidc',
      billingInfo: getBillingSourceInfo('vercel-oidc', { detail: sponsored.modelId }),
      fallbackReason: fallbackNotes.join(' ') || undefined,
    };
  }

  throw new ProviderNotConfiguredError();
}

/**
 * Resolve an AI SDK 7 `LanguageModel` strictly following the 5-tier provider &
 * billing waterfall:
 * 1. Custom OpenAI-Compatible Endpoint
 * 2. User BYOK Key or Signed-in Vercel OAuth Token (with credit verification)
 * 3. Host Sponsor `OPENAI_API_KEY` FIRST
 * 4. Host Sponsor `AI_GATEWAY_API_KEY`
 * 5. Vercel Project OIDC (`VERCEL_OIDC_TOKEN`)
 */
export async function resolveLanguageModel(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedLanguageModel> {
  const backend = await resolveBackend(opts);
  const requestedModelId = trimNonEmpty(opts.modelId) ?? backend.modelId;

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'custom') {
    const provider = createOpenAICompatible({
      name: 'custom-openai',
      baseURL: backend.baseUrl,
      apiKey: backend.apiKey,
      headers: backend.headers,
      includeUsage: true,
    });

    return {
      model: provider.chatModel(backend.modelId),
      modelId: backend.modelId,
      requestedModelId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  if (backend.kind === 'openai') {
    return {
      model: backend.provider(backend.modelId),
      modelId: `openai/${backend.modelId}`,
      requestedModelId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  return {
    model: backend.provider(backend.modelId),
    modelId: backend.modelId,
    requestedModelId,
    billingSource: backend.billingSource,
    billingInfo: backend.billingInfo,
    fallbackReason: backend.fallbackReason,
    creditsRemaining: backend.creditsRemaining,
  };
}

/**
 * Resolve a low-latency fast model for auto-title generation, routing, or quick summaries.
 */
export async function resolveFastLanguageModel(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedLanguageModel> {
  const env = readEnvCredentials();
  const fastDefault =
    !opts.modelId && env.openAIKey && !opts.override?.byokApiKey?.startsWith('vck_')
      ? FAST_OPENAI_MODEL_ID
      : FAST_MODEL_ID;

  return resolveLanguageModel({
    ...opts,
    modelId: opts.modelId ?? fastDefault,
  });
}

/**
 * Resolve an OpenAI image generation model across the 5-tier waterfall.
 * - Gateway, OpenAI, and Custom tiers return `{ kind: 'image-model', model }` (`openai/gpt-image-2`)
 *   for AI SDK 7 `generateImage()`.
 */
export async function resolveImageGenerator(
  opts: ResolveProviderOptions & { prefer?: 'language-files' | 'image-model' } = {},
): Promise<ResolvedImageGenerator> {
  const backend = await resolveBackend({
    ...opts,
    modelId: opts.modelId,
  });

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'gateway') {
    const requested = trimNonEmpty(opts.modelId);
    const imageModelId = requested?.startsWith('openai/gpt-image')
      ? requested
      : IMAGE_OPENAI_MODEL_ID;
    return {
      kind: 'image-model',
      model: backend.provider.imageModel(imageModelId),
      modelId: imageModelId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  if (backend.kind === 'openai') {
    const requested = trimNonEmpty(opts.modelId);
    const directImageId =
      requested && isOpenAIModelId(requested)
        ? stripProviderPrefix(requested)
        : stripProviderPrefix(IMAGE_OPENAI_MODEL_ID);

    return {
      kind: 'image-model',
      model: backend.provider.image(directImageId),
      modelId: directImageId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  const customImageId = trimNonEmpty(opts.modelId) ?? stripProviderPrefix(IMAGE_OPENAI_MODEL_ID);
  const customProvider = createOpenAICompatible({
    name: 'custom-openai',
    baseURL: backend.baseUrl,
    apiKey: backend.apiKey,
    headers: backend.headers,
  });

  return {
    kind: 'image-model',
    model: customProvider.imageModel(customImageId),
    modelId: customImageId,
    billingSource: backend.billingSource,
    billingInfo: backend.billingInfo,
    fallbackReason: backend.fallbackReason,
  };
}

/**
 * Resolve a server-side speech-to-text `TranscriptionModel` for AI SDK 7 `transcribe()`.
 * Falls through custom OpenAI-compatible endpoints to Tier 2b/3/4/5 when available.
 */
export async function resolveTranscriptionModel(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedTranscriptionModel> {
  const requested = trimNonEmpty(opts.modelId);
  let backend: InternalResolvedBackend;

  try {
    backend = await resolveBackend({
      ...opts,
      modelId: requested ?? STT_MODEL_ID,
      allowCustom: false,
    });
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      const parsed = parseOverride(opts.override);
      const env = readEnvCredentials();
      if (parsed.customBaseUrl || env.customBaseUrl) {
        throw new ProviderCapabilityError(
          'custom-endpoint',
          'Custom OpenAI-compatible endpoints do not support server-side transcription; use browser Web Speech API fallback.',
        );
      }
    }
    throw error;
  }

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'openai') {
    const directSttId =
      requested && isOpenAIModelId(requested) ? stripProviderPrefix(requested) : 'whisper-1';
    return {
      model: backend.provider.transcription(directSttId),
      modelId: directSttId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  if (backend.kind === 'gateway') {
    const sttId = requested ?? STT_MODEL_ID;
    return {
      model: backend.provider.transcriptionModel(sttId),
      modelId: sttId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  throw new ProviderCapabilityError(
    backend.billingSource,
    'Active provider does not support server-side audio transcription.',
  );
}

/**
 * Resolve a server-side text-to-speech `SpeechModel` for AI SDK 7 `generateSpeech()`.
 * Falls through custom OpenAI-compatible endpoints to Tier 2b/3/4/5 when available.
 */
export async function resolveSpeechModel(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedSpeechModel> {
  const requested = trimNonEmpty(opts.modelId);
  let backend: InternalResolvedBackend;

  try {
    backend = await resolveBackend({
      ...opts,
      modelId: requested ?? TTS_MODEL_ID,
      allowCustom: false,
    });
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      const parsed = parseOverride(opts.override);
      const env = readEnvCredentials();
      if (parsed.customBaseUrl || env.customBaseUrl) {
        throw new ProviderCapabilityError(
          'custom-endpoint',
          'Custom OpenAI-compatible endpoints do not support server-side speech synthesis; use browser speechSynthesis fallback.',
        );
      }
    }
    throw error;
  }

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'openai') {
    const directTtsId =
      requested && isOpenAIModelId(requested) ? stripProviderPrefix(requested) : 'tts-1';
    return {
      model: backend.provider.speech(directTtsId),
      modelId: directTtsId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  if (backend.kind === 'gateway') {
    const ttsId = requested ?? TTS_MODEL_ID;
    return {
      model: backend.provider.speechModel(ttsId),
      modelId: ttsId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
    };
  }

  throw new ProviderCapabilityError(
    backend.billingSource,
    'Active provider does not support server-side speech synthesis.',
  );
}

/**
 * Resolve server-side Realtime Voice token minting config for `/api/realtime/token`.
 * Never exposes raw API keys or OAuth tokens — callers invoke `mintToken()` on the server
 * to obtain a short-lived ephemeral client secret (`token` + `url` + `expiresAt`).
 */
export async function resolveRealtimeTokenConfig(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedRealtimeTokenConfig> {
  const gatewayRealtimeModelId = toGatewayRealtimeModelId(opts.modelId);

  let backend: InternalResolvedBackend;
  try {
    backend = await resolveBackend({
      ...opts,
      modelId: gatewayRealtimeModelId,
      allowCustom: false,
    });
  } catch (error) {
    const parsed = parseOverride(opts.override);
    const env = readEnvCredentials();
    const isCustomOnly = Boolean(parsed.customBaseUrl || env.customBaseUrl);
    const billingSource: BillingSource = isCustomOnly ? 'custom-endpoint' : 'unconfigured';

    return {
      supported: false,
      transport: 'unsupported',
      modelId: gatewayRealtimeModelId,
      billingSource,
      billingInfo: getBillingSourceInfo(billingSource),
      reason: isCustomOnly
        ? 'Realtime WebSocket voice is unavailable on custom OpenAI-compatible endpoints. Using browser Web Speech fallback.'
        : error instanceof Error
          ? error.message
          : 'No Realtime-capable provider configured.',
    };
  }

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'gateway') {
    return {
      supported: true,
      transport: 'gateway',
      modelId: gatewayRealtimeModelId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
      mintToken: async (tokenOpts) => {
        const result = await backend.provider.experimental_realtime.getToken({
          model: gatewayRealtimeModelId,
          expiresAfterSeconds: tokenOpts?.expiresAfterSeconds,
        });
        return {
          token: result.token,
          url: result.url,
          expiresAt: result.expiresAt,
        };
      },
    };
  }

  if (backend.kind === 'openai') {
    const directRealtimeId = toOpenAIDirectRealtimeModelId(opts.modelId);

    return {
      supported: true,
      transport: 'openai',
      modelId: directRealtimeId,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
      mintToken: async (tokenOpts) => {
        const result = await backend.provider.experimental_realtime.getToken({
          model: directRealtimeId,
          expiresAfterSeconds: tokenOpts?.expiresAfterSeconds,
        });
        return {
          token: result.token,
          url: result.url,
          expiresAt: result.expiresAt,
        };
      },
    };
  }

  return {
    supported: false,
    transport: 'unsupported',
    modelId: gatewayRealtimeModelId,
    billingSource: backend.billingSource,
    billingInfo: backend.billingInfo,
    reason: 'Realtime voice requires Vercel AI Gateway or OpenAI credentials.',
  };
}

function buildCredentialInjectingFetch(
  apiKey?: string,
  extraHeaders?: Record<string, string>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (apiKey && !headers.has('authorization')) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
    }
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

/**
 * Resolve server-side credentials & custom `fetch` wrapper for `libfx` turns.
 * STRICTLY SERVER-ONLY: never serialize the returned `apiKey` or `headers` to clients!
 */
export async function resolveFxCredentials(
  opts: ResolveProviderOptions = {},
): Promise<ResolvedFxCredentials> {
  const backend = await resolveBackend(opts);

  emitProviderMetric(backend.billingSource);

  if (backend.kind === 'custom') {
    const headers = { ...(backend.headers ?? {}) };
    return {
      mode: 'custom',
      baseUrl: backend.baseUrl,
      apiKey: backend.apiKey,
      modelId: backend.modelId,
      headers,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
      createFetch: () => buildCredentialInjectingFetch(backend.apiKey, headers),
    };
  }

  if (backend.kind === 'openai') {
    const headers = { ...(backend.headers ?? {}) };
    return {
      mode: 'openai',
      baseUrl: OPENAI_API_BASE_URL,
      apiKey: backend.apiKey,
      modelId: backend.modelId,
      headers,
      billingSource: backend.billingSource,
      billingInfo: backend.billingInfo,
      fallbackReason: backend.fallbackReason,
      createFetch: () => buildCredentialInjectingFetch(backend.apiKey, headers),
    };
  }

  let gatewayApiKey = backend.apiKey;
  if (!gatewayApiKey && backend.billingSource === 'vercel-oidc') {
    gatewayApiKey =
      trimNonEmpty(process.env.VERCEL_OIDC_TOKEN) ??
      (await getVercelOidcToken().catch(() => undefined));
  }

  const headers: Record<string, string> = { ...(backend.headers ?? {}) };
  if (backend.teamIdOrSlug) {
    headers['x-vercel-ai-gateway-team'] = backend.teamIdOrSlug;
  }

  return {
    mode: 'gateway',
    baseUrl: GATEWAY_OPENAI_COMPAT_BASE_URL,
    apiKey: gatewayApiKey,
    modelId: backend.modelId,
    headers,
    billingSource: backend.billingSource,
    billingInfo: backend.billingInfo,
    fallbackReason: backend.fallbackReason,
    createFetch: () => buildCredentialInjectingFetch(gatewayApiKey, headers),
  };
}

/**
 * Compute a safe, zero-secret summary of all 5 provider tiers, active billing source,
 * OAuth readiness, and signed-in Vercel credit balance for UI badges and Settings.
 */
export async function getProviderDiagnostics(
  userVercelAuth?: UserVercelAuth | null,
  override?: ProviderOverrideInput | null,
): Promise<ProviderDiagnostics> {
  const env = readEnvCredentials();
  const parsed = parseOverride(override);

  const hasCustomOverride = Boolean(parsed.customBaseUrl);
  const hasCustomEnv = Boolean(env.customBaseUrl);
  const hasByokOverride = Boolean(parsed.byokApiKey);
  const hasUserVercelAuth = Boolean(trimNonEmpty(userVercelAuth?.accessToken));

  let userCreditsInfo: ProviderDiagnostics['userCredits'];
  let userOAuthUsable = false;
  let fallbackReason: string | undefined;

  if (hasUserVercelAuth && userVercelAuth) {
    const userOAuth = await resolveUserVercelOAuthToken(userVercelAuth, parsed.teamIdOrSlug);
    userOAuthUsable = userOAuth.usable;
    if (userOAuth.credits) {
      userCreditsInfo = {
        checked: true,
        ok: userOAuth.credits.ok,
        balance: userOAuth.credits.balance,
        totalUsed: userOAuth.credits.totalUsed,
        status: userOAuth.credits.status,
        reason: userOAuth.credits.reason,
      };
    }
    if (!userOAuth.usable && userOAuth.fallbackReason) {
      fallbackReason = userOAuth.fallbackReason;
    }
  }

  const isExplicitByokMode = parsed.mode === 'byok-gateway' || parsed.mode === 'byok-openai';
  const envCustomBaseUrl = !isExplicitByokMode ? env.customBaseUrl : undefined;
  const configuredCustomBaseUrl = parsed.customBaseUrl ?? envCustomBaseUrl;

  let activeBillingSource: BillingSource = 'unconfigured';
  let activeBillingInfo: BillingSourceInfo = getBillingSourceInfo('unconfigured');
  let defaultModelId = DEFAULT_MODEL_ID;

  if (parsed.customBaseUrl) {
    activeBillingSource = 'custom-endpoint';
    defaultModelId = parsed.customModel ?? DEFAULT_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('custom-endpoint', {
      providerName: safeHostLabel(parsed.customBaseUrl),
      detail: defaultModelId,
    });
  } else if (parsed.byokApiKey && parsed.byokKind === 'gateway') {
    activeBillingSource = 'user-byok-gateway';
    defaultModelId = DEFAULT_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('user-byok-gateway');
  } else if (parsed.byokApiKey && parsed.byokKind === 'openai') {
    activeBillingSource = 'user-byok-openai';
    defaultModelId = DEFAULT_OPENAI_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('user-byok-openai');
  } else if (envCustomBaseUrl) {
    activeBillingSource = 'custom-endpoint';
    defaultModelId = parsed.customModel ?? env.customModel ?? DEFAULT_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('custom-endpoint', {
      providerName: safeHostLabel(envCustomBaseUrl),
      detail: defaultModelId,
    });
  } else if (userOAuthUsable) {
    activeBillingSource = 'user-vercel-oauth';
    defaultModelId = DEFAULT_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('user-vercel-oauth', {
      creditsRemaining: userCreditsInfo?.balance ?? null,
    });
  } else if (env.openAIKey) {
    activeBillingSource = 'sponsor-openai';
    defaultModelId = DEFAULT_SPONSORED_OPENAI_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('sponsor-openai');
  } else if (env.gatewayKey) {
    activeBillingSource = 'sponsor-gateway';
    defaultModelId = DEFAULT_SPONSORED_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('sponsor-gateway');
  } else if (env.hasOidcRuntime) {
    activeBillingSource = 'vercel-oidc';
    defaultModelId = DEFAULT_SPONSORED_MODEL_ID;
    activeBillingInfo = getBillingSourceInfo('vercel-oidc');
  }

  const sponsoredOnlyModels =
    !activeBillingInfo.isUserBilled && activeBillingSource !== 'unconfigured';

  const tiers: ProviderTierStatus[] = [
    {
      tier: 1,
      id: 'custom-endpoint',
      label: 'Custom OpenAI-Compatible Endpoint',
      configured: Boolean(configuredCustomBaseUrl),
      active: activeBillingSource === 'custom-endpoint',
      detail: configuredCustomBaseUrl ? safeHostLabel(configuredCustomBaseUrl) : undefined,
    },
    {
      tier: 2,
      id: 'user-byok',
      label: 'Your BYOK API Key (OpenAI / Gateway)',
      configured: hasByokOverride,
      active:
        activeBillingSource === 'user-byok-gateway' || activeBillingSource === 'user-byok-openai',
      detail:
        parsed.byokKind === 'gateway'
          ? 'Vercel AI Gateway key configured'
          : parsed.byokKind === 'openai'
            ? 'OpenAI key configured'
            : undefined,
    },
    {
      tier: 2,
      id: 'user-vercel-oauth',
      label: 'Signed-in Vercel Account Credits',
      configured: hasUserVercelAuth,
      active: activeBillingSource === 'user-vercel-oauth',
      detail: userCreditsInfo?.ok
        ? userCreditsInfo.balance !== undefined
          ? `$${userCreditsInfo.balance.toFixed(2)} remaining`
          : 'Active'
        : userCreditsInfo?.reason,
    },
    {
      tier: 3,
      id: 'sponsor-openai',
      label: 'Host Sponsor OpenAI (Primary)',
      configured: Boolean(env.openAIKey),
      active: activeBillingSource === 'sponsor-openai',
      detail: env.openAIKey ? 'OPENAI_API_KEY configured (used first)' : undefined,
    },
    {
      tier: 4,
      id: 'sponsor-gateway',
      label: 'Host Sponsor AI Gateway',
      configured: Boolean(env.gatewayKey),
      active: activeBillingSource === 'sponsor-gateway',
      detail: env.gatewayKey ? 'AI_GATEWAY_API_KEY configured' : undefined,
    },
    {
      tier: 5,
      id: 'vercel-oidc',
      label: 'Vercel Project OIDC (Zero-Config)',
      configured: env.hasOidcRuntime,
      active: activeBillingSource === 'vercel-oidc',
      detail: env.hasOidcRuntime ? 'VERCEL_OIDC_TOKEN active' : undefined,
    },
  ];

  return {
    activeBillingSource,
    activeBillingInfo,
    defaultModelId,
    sponsoredOnlyModels,
    sponsoredModelIds: SPONSORED_MODEL_IDS,
    fallbackReason,
    vercelOAuthConfigured: env.vercelOAuthConfigured,
    vercelConnectConfigured: env.vercelConnectConfigured,
    hasCustomEnv,
    hasCustomOverride,
    hasByokOverride,
    hasUserVercelAuth,
    hasOpenAIKey: Boolean(env.openAIKey),
    hasGatewayKey: Boolean(env.gatewayKey),
    hasOidcToken: env.hasOidcRuntime,
    userCredits: userCreditsInfo,
    tiers,
  };
}
