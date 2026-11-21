import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GatewayAuthenticationError, GatewayForbiddenError } from '@ai-sdk/gateway';
import { APICallError } from 'ai';
import {
  GET as getProviderStatus,
  POST as postProviderStatus,
} from '@/app/api/provider/status/route';
import {
  checkVercelGatewayCredits,
  invalidateVercelGatewayCreditsCache,
  isUserTokenBillingError,
  refreshVercelOAuthToken,
} from '@/lib/ai/credits';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  DEFAULT_SPONSORED_MODEL_ID,
  DEFAULT_SPONSORED_OPENAI_MODEL_ID,
  FAST_MODEL_ID,
  FAST_OPENAI_MODEL_ID,
  MODEL_CATALOG,
  SPONSORED_MODEL_IDS,
  toOpenAIDirectModelId,
} from '@/lib/ai/models';
import {
  getProviderDiagnostics,
  ProviderNotConfiguredError,
  resolveFastLanguageModel,
  resolveLanguageModel,
  resolveRealtimeTokenConfig,
  type UserVercelAuth,
} from '@/lib/ai/provider';

const PROVIDER_ENV_KEYS = [
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'VERCEL',
  'VERCEL_CLIENT_ID',
  'VERCEL_CLIENT_SECRET',
  'VERCEL_CONNECT_VERCEL_UID',
  'DATABASE_URL',
] as const;

type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];

const originalFetch = globalThis.fetch;
let savedEnv: Partial<Record<ProviderEnvKey, string | undefined>> = {};

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
}

function setMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

describe('5-tier provider & billing waterfall', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    clearProviderEnv();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of PROVIDER_ENV_KEYS) {
      const prev = savedEnv[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it('Tier 1 (custom-endpoint) beats all other tiers when customBaseUrl override is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-host-openai-secret-111';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway_secret_222';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_host_token_333';

    const resolved = await resolveLanguageModel({
      modelId: 'anthropic/claude-sonnet-5.5',
      override: {
        mode: 'auto',
        customBaseUrl: 'http://localhost:11434/v1/',
        customApiKey: 'custom-secret-key-444',
        customModel: 'qwen3-coder:32b',
        byokApiKey: 'vck_user_byok_should_lose',
      },
      userVercelAuth: {
        accessToken: 'vca_user_oauth_should_lose',
      },
    });

    expect(resolved.billingSource).toBe('custom-endpoint');
    expect(resolved.modelId).toBe('qwen3-coder:32b');
    expect(resolved.billingInfo.isUserBilled).toBe(true);
    expect(resolved.billingInfo.providerName).toBe('localhost:11434');
  });

  it('Tier 1 (custom-endpoint) activates from OPENAI_COMPATIBLE_BASE_URL env var ahead of host keys', async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://openrouter.example.test/api/v1';
    process.env.OPENAI_COMPATIBLE_API_KEY = 'or-secret-env-key';
    process.env.OPENAI_COMPATIBLE_MODEL = 'deepseek/r1';
    process.env.OPENAI_API_KEY = 'sk-host-openai-env';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway_env';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_token_env';

    const resolved = await resolveLanguageModel();
    expect(resolved.billingSource).toBe('custom-endpoint');
    expect(resolved.modelId).toBe('deepseek/r1');
    expect(resolved.billingInfo.providerName).toBe('openrouter.example.test');
  });

  it('Tier 2a (user-byok-gateway for vck_*) beats host OPENAI_COMPATIBLE_BASE_URL, user OAuth, and all host keys', async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://host-custom.example.test/v1';
    process.env.OPENAI_API_KEY = 'sk-host-openai';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_host_token';

    const resolved = await resolveLanguageModel({
      modelId: 'anthropic/claude-opus-5.5',
      override: {
        mode: 'auto',
        byokApiKey: 'vck_user_byok_key_999',
      },
      userVercelAuth: {
        accessToken: 'vca_user_oauth_token_888',
      },
    });

    expect(resolved.billingSource).toBe('user-byok-gateway');
    expect(resolved.modelId).toBe('anthropic/claude-opus-5.5');
    expect(resolved.billingInfo.isUserBilled).toBe(true);
  });

  it('Tier 2a (user-byok-openai for sk-*) beats host keys and maps non-OpenAI models cleanly', async () => {
    process.env.OPENAI_API_KEY = 'sk-host-openai';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_host_token';

    const directOpenAI = await resolveLanguageModel({
      modelId: 'openai/gpt-6.2-sol',
      override: {
        mode: 'auto',
        byokApiKey: 'sk-user-byok-openai-777',
      },
    });
    expect(directOpenAI.billingSource).toBe('user-byok-openai');
    expect(directOpenAI.modelId).toBe('openai/gpt-6.2-sol');
    expect(directOpenAI.fallbackReason).toBeUndefined();

    const mappedFromClaude = await resolveLanguageModel({
      modelId: 'anthropic/claude-sonnet-5.5',
      override: {
        mode: 'byok-openai',
        apiKey: 'sk-user-byok-openai-777',
      },
    });
    expect(mappedFromClaude.billingSource).toBe('user-byok-openai');
    expect(mappedFromClaude.modelId).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(mappedFromClaude.fallbackReason).toContain('Mapped anthropic/claude-sonnet-5.5');
  });

  it('Tier 2b (user-vercel-oauth) checks /v1/credits and uses user token when balance > 0', async () => {
    process.env.OPENAI_API_KEY = 'sk-host-openai';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway';

    const token = `vca_valid_balance_${Date.now()}`;
    invalidateVercelGatewayCreditsCache(token);

    let capturedAuthHeader = '';
    setMockFetch(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://ai-gateway.vercel.sh/v1/credits')) {
        capturedAuthHeader = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({ balance: '18.75', total_used: '4.25' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const resolved = await resolveLanguageModel({
      modelId: 'anthropic/claude-opus-5.5',
      userVercelAuth: {
        accessToken: token,
      },
    });

    expect(capturedAuthHeader).toBe(`Bearer ${token}`);
    expect(resolved.billingSource).toBe('user-vercel-oauth');
    expect(resolved.modelId).toBe('anthropic/claude-opus-5.5');
    expect(resolved.creditsRemaining).toBe(18.75);
    expect(resolved.billingInfo.isUserBilled).toBe(true);

    // Non-OpenAI/Anthropic models are still rejected even with user OAuth tokens
    const clampedNonAllowed = await resolveLanguageModel({
      modelId: 'google/gemini-4-carbon',
      userVercelAuth: {
        accessToken: token,
      },
    });
    expect(clampedNonAllowed.billingSource).toBe('user-vercel-oauth');
    expect(clampedNonAllowed.modelId).toBe(DEFAULT_MODEL_ID);
    expect(clampedNonAllowed.fallbackReason).toContain('Only OpenAI and Anthropic');

    // Subsequent credits lookup should be cached.
    const cachedCheck = await checkVercelGatewayCredits(token);
    expect(cachedCheck.ok).toBe(true);
    expect(cachedCheck.cached).toBe(true);
    invalidateVercelGatewayCreditsCache(token);
  });

  it('Tier 2b auto-refreshes near-expiry Vercel OAuth tokens before checking credits', async () => {
    process.env.VERCEL_CLIENT_ID = 'client_id_test';
    process.env.VERCEL_CLIENT_SECRET = 'client_secret_test';
    process.env.OPENAI_API_KEY = 'sk-host-openai';

    const oldToken = `vca_expiring_${Date.now()}`;
    const refreshedToken = `vca_refreshed_${Date.now()}`;
    invalidateVercelGatewayCreditsCache(oldToken);
    invalidateVercelGatewayCreditsCache(refreshedToken);

    let refreshedCallbackToken = '';
    setMockFetch(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.vercel.com/login/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: 'vcr_next_refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://ai-gateway.vercel.sh/v1/credits')) {
        const auth = new Headers(init?.headers).get('authorization');
        expect(auth).toBe(`Bearer ${refreshedToken}`);
        return new Response(JSON.stringify({ balance: 9.5, total_used: 0.5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const userAuth: UserVercelAuth = {
      accessToken: oldToken,
      refreshToken: 'vcr_old_refresh',
      expiresAt: Date.now() + 30_000, // Within 2-minute refresh buffer
      onRefreshed: (tokens) => {
        refreshedCallbackToken = tokens.accessToken;
      },
    };

    const resolved = await resolveLanguageModel({ userVercelAuth: userAuth });
    expect(refreshedCallbackToken).toBe(refreshedToken);
    expect(resolved.billingSource).toBe('user-vercel-oauth');
    expect(resolved.creditsRemaining).toBe(9.5);
    invalidateVercelGatewayCreditsCache(refreshedToken);
  });

  it('Tier 2b reactively refreshes once on HTTP 401 from /v1/credits when refreshToken is present', async () => {
    process.env.VERCEL_CLIENT_ID = 'client_id_reactive';
    process.env.VERCEL_CLIENT_SECRET = 'client_secret_reactive';
    process.env.OPENAI_API_KEY = 'sk-host-openai';

    const staleToken = `vca_stale_401_${Date.now()}`;
    const freshToken = `vca_fresh_401_${Date.now()}`;
    invalidateVercelGatewayCreditsCache(staleToken);
    invalidateVercelGatewayCreditsCache(freshToken);

    let persistedFreshToken = '';
    setMockFetch(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.vercel.com/login/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: freshToken,
            refresh_token: 'vcr_rotated',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://ai-gateway.vercel.sh/v1/credits')) {
        const auth = new Headers(init?.headers).get('authorization');
        if (auth === `Bearer ${staleToken}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        if (auth === `Bearer ${freshToken}`) {
          return new Response(JSON.stringify({ balance: 15.0, total_used: 1.0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const resolved = await resolveLanguageModel({
      userVercelAuth: {
        accessToken: staleToken,
        refreshToken: 'vcr_initial',
        onRefreshed: (tokens) => {
          persistedFreshToken = tokens.accessToken;
        },
      },
    });
    expect(persistedFreshToken).toBe(freshToken);
    expect(resolved.billingSource).toBe('user-vercel-oauth');
    expect(resolved.creditsRemaining).toBe(15.0);
    invalidateVercelGatewayCreditsCache(staleToken);
    invalidateVercelGatewayCreditsCache(freshToken);
  });

  it('Tier 2b falls back cleanly to Tier 3 when balance is $0 or /v1/credits returns 401/402/403', async () => {
    process.env.OPENAI_API_KEY = 'sk-host-openai-fallback';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway_fallback';

    // 1. Zero balance -> falls back to Tier 3 sponsor-openai (when no non-OpenAI model requested)
    const zeroToken = `vca_zero_balance_${Date.now()}`;
    invalidateVercelGatewayCreditsCache(zeroToken);
    setMockFetch(async () => {
      return new Response(JSON.stringify({ balance: 0, total_used: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const zeroRes = await resolveLanguageModel({
      userVercelAuth: { accessToken: zeroToken },
    });
    expect(zeroRes.billingSource).toBe('sponsor-openai');
    expect(zeroRes.fallbackReason).toContain('$0');
    invalidateVercelGatewayCreditsCache(zeroToken);

    // 2. HTTP 401 / 402 / 403 -> all fall back cleanly to Tier 3 sponsor-openai
    for (const status of [401, 402, 403] as const) {
      const errToken = `vca_http_${status}_${Date.now()}`;
      invalidateVercelGatewayCreditsCache(errToken);
      setMockFetch(async () => {
        return new Response(JSON.stringify({ error: `HTTP ${status}` }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });

      const res = await resolveLanguageModel({
        userVercelAuth: { accessToken: errToken },
      });
      expect(res.billingSource).toBe('sponsor-openai');
      expect(res.fallbackReason).toBeDefined();
      invalidateVercelGatewayCreditsCache(errToken);
    }

    // 3. skipUserToken=true bypasses Tier 2b without calling /v1/credits
    let fetchCalled = false;
    setMockFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ balance: 100 }), { status: 200 });
    });
    const skipped = await resolveLanguageModel({
      userVercelAuth: { accessToken: 'vca_should_be_skipped' },
      skipUserToken: true,
    });
    expect(fetchCalled).toBe(false);
    expect(skipped.billingSource).toBe('sponsor-openai');
  });

  it('isUserTokenBillingError accurately classifies billing/auth errors vs unrelated errors', () => {
    // True positives
    expect(isUserTokenBillingError({ statusCode: 401 })).toBe(true);
    expect(isUserTokenBillingError({ status: 402 })).toBe(true);
    expect(isUserTokenBillingError({ httpStatus: 403 })).toBe(true);
    expect(
      isUserTokenBillingError(new GatewayAuthenticationError({ message: 'Invalid token' })),
    ).toBe(true);
    expect(isUserTokenBillingError(new GatewayForbiddenError({ message: 'Missing scope' }))).toBe(
      true,
    );
    expect(
      isUserTokenBillingError(
        new APICallError({
          message: 'Payment required',
          url: 'https://ai-gateway.vercel.sh/v1',
          requestBodyValues: {},
          statusCode: 402,
          isRetryable: false,
        }),
      ),
    ).toBe(true);
    expect(isUserTokenBillingError(new Error('Insufficient credits for this request'))).toBe(true);
    expect(isUserTokenBillingError(new Error('Access token expired'))).toBe(true);
    expect(isUserTokenBillingError(new Error('Missing AI Gateway: Use permission'))).toBe(true);
    expect(
      isUserTokenBillingError({
        cause: { lastError: new Error('Out of credits') },
      }),
    ).toBe(true);
    expect(
      isUserTokenBillingError({
        errors: [new Error('transient'), { status: 401 }],
      }),
    ).toBe(true);

    // True negatives
    expect(isUserTokenBillingError(null)).toBe(false);
    expect(isUserTokenBillingError(undefined)).toBe(false);
    expect(isUserTokenBillingError({ statusCode: 429, message: 'Rate limit exceeded' })).toBe(
      false,
    );
    expect(isUserTokenBillingError({ statusCode: 500, message: 'Internal server error' })).toBe(
      false,
    );
    expect(isUserTokenBillingError(new Error('ECONNRESET socket hang up'))).toBe(false);
    expect(isUserTokenBillingError(new Error('Context length exceeded'))).toBe(false);
  });

  it('Tier 3 (sponsor-openai) prioritizes OPENAI_API_KEY BEFORE AI_GATEWAY_API_KEY and clamps to GPT-6 Luna', async () => {
    process.env.OPENAI_API_KEY = 'sk-host-openai-primary';
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway_secondary';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_tertiary';

    // Default (no modelId specified) MUST select sponsor-openai first with sponsored GPT-6 Luna!
    const defaultRes = await resolveLanguageModel();
    expect(defaultRes.billingSource).toBe('sponsor-openai');
    expect(defaultRes.modelId).toBe(DEFAULT_SPONSORED_OPENAI_MODEL_ID);

    // Flagship OpenAI model requested without BYOK MUST clamp to sponsored GPT-6 Luna!
    const explicitOpenAI = await resolveLanguageModel({ modelId: 'openai/gpt-5.3-codex' });
    expect(explicitOpenAI.billingSource).toBe('sponsor-openai');
    expect(explicitOpenAI.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(explicitOpenAI.fallbackReason).toContain('Sponsored demo mode');

    // Fast model helper picks OpenAI GPT-6 Luna without clamping
    const fastRes = await resolveFastLanguageModel();
    expect(fastRes.billingSource).toBe('sponsor-openai');
    expect(fastRes.modelId).toBe(FAST_OPENAI_MODEL_ID);

    // Diagnostics default active source MUST be sponsor-openai with sponsoredOnlyModels = true
    const diagnostics = await getProviderDiagnostics();
    expect(diagnostics.activeBillingSource).toBe('sponsor-openai');
    expect(diagnostics.defaultModelId).toBe(DEFAULT_SPONSORED_OPENAI_MODEL_ID);
    expect(diagnostics.sponsoredOnlyModels).toBe(true);

    // If ONLY OPENAI_API_KEY is set (no gateway/OIDC), Anthropic models clamp cleanly to GPT-6 Luna
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    const claudeOnlyOpenAI = await resolveLanguageModel({
      modelId: 'anthropic/claude-haiku-5.5',
    });
    expect(claudeOnlyOpenAI.billingSource).toBe('sponsor-openai');
    expect(claudeOnlyOpenAI.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(claudeOnlyOpenAI.fallbackReason).toContain('Sponsored demo mode');
    expect(toOpenAIDirectModelId('openai/gpt-6.2-sol')).toBe('gpt-6.2-sol');
  });

  it('Tier 4 (sponsor-gateway) is used when OPENAI_API_KEY is absent OR Anthropic is requested, clamped to Haiku 5.5 & GPT-6 Luna', async () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_host_gateway_tier4';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_tier5';

    // Without OPENAI_API_KEY -> Tier 4 beats Tier 5 and defaults to sponsored Claude Haiku 5.5
    const noOpenAI = await resolveLanguageModel();
    expect(noOpenAI.billingSource).toBe('sponsor-gateway');
    expect(noOpenAI.modelId).toBe(DEFAULT_SPONSORED_MODEL_ID);

    // Explicit GPT-6 Luna is allowed on sponsored Gateway
    const sponsoredLuna = await resolveLanguageModel({ modelId: 'openai/gpt-6-luna' });
    expect(sponsoredLuna.billingSource).toBe('sponsor-gateway');
    expect(sponsoredLuna.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(sponsoredLuna.fallbackReason).toBeUndefined();

    // Flagship OpenAI model clamps to GPT-6 Luna on sponsored Gateway
    const clampedSol = await resolveLanguageModel({ modelId: 'openai/gpt-6.2-sol' });
    expect(clampedSol.billingSource).toBe('sponsor-gateway');
    expect(clampedSol.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(clampedSol.fallbackReason).toContain('Sponsored demo mode');

    // With BOTH OPENAI_API_KEY and AI_GATEWAY_API_KEY, explicit Anthropic flagship clamps to Haiku 5.5 via Tier 4
    process.env.OPENAI_API_KEY = 'sk-host-openai-tier3';
    const explicitClaude = await resolveLanguageModel({
      modelId: 'anthropic/claude-sonnet-5.5',
    });
    expect(explicitClaude.billingSource).toBe('sponsor-gateway');
    expect(explicitClaude.modelId).toBe(FAST_MODEL_ID);
    expect(explicitClaude.fallbackReason).toContain('Sponsored demo mode');
  });

  it('Tier 5 (vercel-oidc) acts as zero-config fallback and enforces Haiku 5.5 & GPT-6 Luna only', async () => {
    process.env.VERCEL_OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.oidc_payload.sig';

    const resolved = await resolveLanguageModel();
    expect(resolved.billingSource).toBe('vercel-oidc');
    expect(resolved.modelId).toBe(DEFAULT_SPONSORED_MODEL_ID);
    expect(resolved.billingInfo.isUserBilled).toBe(false);

    // Flagship models & disallowed providers MUST clamp strictly to Haiku 5.5 / GPT-6 Luna
    const opusClamped = await resolveLanguageModel({ modelId: 'anthropic/claude-opus-5.5' });
    expect(opusClamped.modelId).toBe(FAST_MODEL_ID);
    expect(opusClamped.fallbackReason).toContain('Sponsored demo mode');

    const astraClamped = await resolveLanguageModel({ modelId: 'openai/gpt-6.2-astra' });
    expect(astraClamped.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(astraClamped.fallbackReason).toContain('Sponsored demo mode');

    const googleClamped = await resolveLanguageModel({ modelId: 'google/gemini-4-carbon' });
    expect(googleClamped.modelId).toBe(FAST_OPENAI_MODEL_ID);
    expect(resolved.modelId).toBe('openai/gpt-6-luna');

    // User BYOK key unlocks flagship Anthropic + OpenAI models immediately
    const byokUnlocked = await resolveLanguageModel({
      modelId: 'anthropic/claude-opus-5.5',
      override: { byokApiKey: 'vck_user_unlocks_flagship' },
    });
    expect(byokUnlocked.billingSource).toBe('user-byok-gateway');
    expect(byokUnlocked.modelId).toBe('anthropic/claude-opus-5.5');
    expect(byokUnlocked.billingInfo.isUserBilled).toBe(true);

    // Curated catalog is strictly Anthropic + OpenAI with ONLY Haiku 5.5 & GPT-6 Luna sponsored-eligible
    const providers = new Set(MODEL_CATALOG.map((m) => m.provider));
    expect([...providers].sort()).toEqual(['anthropic', 'openai']);
    const sponsoredIds = MODEL_CATALOG.filter((m) => m.sponsoredEligible).map((m) => m.id);
    expect(sponsoredIds).toEqual([...SPONSORED_MODEL_IDS]);

    const diagnostics = await getProviderDiagnostics();
    expect(diagnostics.activeBillingSource).toBe('vercel-oidc');
    expect(diagnostics.defaultModelId).toBe(DEFAULT_SPONSORED_MODEL_ID);
    expect(diagnostics.sponsoredOnlyModels).toBe(true);
    expect(diagnostics.hasOidcToken).toBe(true);
  });

  it('throws ProviderNotConfiguredError when no tier is configured', async () => {
    await expect(resolveLanguageModel()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    const diagnostics = await getProviderDiagnostics();
    expect(diagnostics.activeBillingSource).toBe('unconfigured');
  });

  it('resolveRealtimeTokenConfig coerces non-realtime chat models to valid Gateway/OpenAI realtime models', async () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_realtime_gateway';
    const gwRealtime = await resolveRealtimeTokenConfig({
      modelId: 'anthropic/claude-sonnet-5.5',
    });
    expect(gwRealtime.supported).toBe(true);
    expect(gwRealtime.transport).toBe('gateway');
    expect(gwRealtime.modelId).toBe('openai/gpt-realtime-2');

    delete process.env.AI_GATEWAY_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-realtime-openai';
    const openaiRealtime = await resolveRealtimeTokenConfig({
      modelId: 'openai/gpt-6.2-sol',
    });
    expect(openaiRealtime.supported).toBe(true);
    expect(openaiRealtime.transport).toBe('openai');
    expect(openaiRealtime.modelId).toBe('gpt-realtime');
  });

  it('refreshVercelOAuthToken supports Vercel Connect refresh via connect.vercel.com when VERCEL_CONNECT_VERCEL_UID is set', async () => {
    process.env.VERCEL_CONNECT_VERCEL_UID = 'conn_uid_123';
    process.env.VERCEL_OIDC_TOKEN = 'oidc_connect_jwt_456';

    let capturedUrl = '';
    let capturedAuth = '';
    setMockFetch(async (input, init) => {
      capturedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedAuth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(
        JSON.stringify({
          access_token: 'vca_connect_refreshed_789',
          refresh_token: 'vcr_connect_rotated_999',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const refreshed = await refreshVercelOAuthToken('vcr_connect_initial', {
      providerId: 'vercel-connect',
    });
    expect(capturedUrl).toBe('https://connect.vercel.com/oauth/token');
    expect(capturedAuth.startsWith('Basic ')).toBe(true);
    expect(refreshed?.accessToken).toBe('vca_connect_refreshed_789');
    expect(refreshed?.refreshToken).toBe('vcr_connect_rotated_999');
  });

  it('NEVER leaks raw secrets in getProviderDiagnostics() or /api/provider/status', async () => {
    const secrets = {
      customEnvKey: 'secret-custom-env-key-AAAA1111',
      customOverrideKey: 'secret-custom-ui-key-BBBB2222',
      byokKey: 'vck_secret_byok_key_CCCC3333',
      oauthAccess: 'vca_secret_oauth_access_DDDD4444',
      oauthRefresh: 'vcr_secret_oauth_refresh_EEEE5555',
      hostOpenAI: 'sk-secret-host-openai-FFFF6666',
      hostGateway: 'vck_secret_host_gateway_GGGG7777',
      oidcToken: 'oidc-secret-jwt-token-HHHH8888',
      vercelClientSecret: 'vercel-client-secret-IIII9999',
    };

    process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://proxy.internal.test/v1';
    process.env.OPENAI_COMPATIBLE_API_KEY = secrets.customEnvKey;
    process.env.OPENAI_API_KEY = secrets.hostOpenAI;
    process.env.AI_GATEWAY_API_KEY = secrets.hostGateway;
    process.env.VERCEL_OIDC_TOKEN = secrets.oidcToken;
    process.env.VERCEL_CLIENT_ID = 'client_public_id';
    process.env.VERCEL_CLIENT_SECRET = secrets.vercelClientSecret;

    invalidateVercelGatewayCreditsCache(secrets.oauthAccess);
    setMockFetch(async () => {
      return new Response(JSON.stringify({ balance: 42.0, total_used: 3.0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const diagnostics = await getProviderDiagnostics(
      {
        accessToken: secrets.oauthAccess,
        refreshToken: secrets.oauthRefresh,
      },
      {
        mode: 'auto',
        customBaseUrl: 'https://custom-ui.example.test/v1',
        customApiKey: secrets.customOverrideKey,
        byokApiKey: secrets.byokKey,
      },
    );

    const diagnosticsJson = JSON.stringify(diagnostics);
    for (const secretValue of Object.values(secrets)) {
      expect(diagnosticsJson).not.toContain(secretValue);
    }

    const getRes = await getProviderStatus(
      new Request('http://localhost:3000/api/provider/status'),
    );
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    for (const secretValue of Object.values(secrets)) {
      expect(getText).not.toContain(secretValue);
    }
    const getJson = JSON.parse(getText) as { models: unknown[]; diagnostics: { tiers: unknown[] } };
    expect(getJson.models.length).toBe(MODEL_CATALOG.length);
    expect(getJson.diagnostics.tiers.length).toBe(6);

    const postRes = await postProviderStatus(
      new Request('http://localhost:3000/api/provider/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'byok-gateway',
          byokApiKey: secrets.byokKey,
          customApiKey: secrets.customOverrideKey,
        }),
      }),
    );
    expect(postRes.status).toBe(200);
    const postText = await postRes.text();
    for (const secretValue of Object.values(secrets)) {
      expect(postText).not.toContain(secretValue);
    }

    invalidateVercelGatewayCreditsCache(secrets.oauthAccess);
  });
});
