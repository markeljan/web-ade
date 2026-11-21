import type { ModelDefinition, ModelProviderFamily } from '@/lib/types';

export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-5.5';
export const DEFAULT_OPENAI_MODEL_ID = 'openai/gpt-6.2-sol';
export const FAST_MODEL_ID = 'anthropic/claude-haiku-5.5';
export const FAST_OPENAI_MODEL_ID = 'openai/gpt-6-luna';

/** Models permitted on host-sponsored tiers (no user-provided API key / custom endpoint). */
export const SPONSORED_MODEL_IDS = [FAST_OPENAI_MODEL_ID, FAST_MODEL_ID] as const;
export const DEFAULT_SPONSORED_MODEL_ID = FAST_OPENAI_MODEL_ID;
export const DEFAULT_SPONSORED_OPENAI_MODEL_ID = FAST_OPENAI_MODEL_ID;

const SPONSORED_MODEL_SET = new Set<string>(SPONSORED_MODEL_IDS);

export const IMAGE_GATEWAY_MODEL_ID = 'openai/gpt-image-2';
export const IMAGE_OPENAI_MODEL_ID = 'openai/gpt-image-2';
export const STT_MODEL_ID = 'openai/gpt-transcribe';
export const TTS_MODEL_ID = 'openai/tts-1';
export const REALTIME_MODEL_ID = 'openai/gpt-realtime-2';
export const REALTIME_OPENAI_DIRECT_MODEL_ID = 'gpt-realtime';

export const GATEWAY_REALTIME_MODEL_IDS = [
  'openai/gpt-realtime-2',
  'openai/gpt-realtime-2.1',
  'openai/gpt-realtime-1.5',
  'openai/gpt-realtime-mini',
  'openai/gpt-live-1',
] as const;

const GATEWAY_REALTIME_MODEL_SET = new Set<string>(GATEWAY_REALTIME_MODEL_IDS);

export const MODEL_CATALOG: readonly ModelDefinition[] = [
  // OpenAI
  {
    id: 'openai/gpt-6-luna',
    openaiDirectId: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    provider: 'openai',
    description:
      'Default fast OpenAI model for instant replies, coding, and sponsored demo sessions.',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'fast',
    sponsoredEligible: true,
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
  },
  {
    id: 'openai/gpt-6.1-terra',
    openaiDirectId: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    provider: 'openai',
    description: 'Cost-efficient everyday OpenAI reasoning and tool-calling model (BYOK).',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'balanced',
    sponsoredEligible: false,
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 5.0,
  },
  {
    id: 'openai/gpt-6.2-sol',
    openaiDirectId: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    provider: 'openai',
    description:
      'OpenAI flagship balanced model with strong multimodal, tool, and coding craft (BYOK).',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'balanced',
    sponsoredEligible: false,
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 10.0,
  },
  {
    id: 'openai/gpt-6.2-astra',
    openaiDirectId: 'gpt-6.2-astra',
    name: 'GPT-6.2 Astra',
    provider: 'openai',
    description:
      'Maximum-capability OpenAI reasoning model for complex systems design and debugging (BYOK).',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'flagship',
    sponsoredEligible: false,
    inputCostPerMillion: 8.0,
    outputCostPerMillion: 40.0,
  },
  {
    id: 'openai/gpt-5.3-codex',
    openaiDirectId: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'openai',
    description:
      'Purpose-built OpenAI software engineering model tuned for shell & repo loops (BYOK).',
    contextWindow: 400_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'coding',
    sponsoredEligible: false,
    inputCostPerMillion: 1.5,
    outputCostPerMillion: 6.0,
  },

  // Anthropic
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    provider: 'anthropic',
    description:
      'Ultra-low-latency Anthropic model for fast edits, routing, and sponsored demo sessions.',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'fast',
    sponsoredEligible: true,
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    provider: 'anthropic',
    description: 'Balanced frontier reasoning, coding, and agentic tool use (BYOK).',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'balanced',
    sponsoredEligible: false,
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 10.0,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    name: 'Claude Opus 5.5',
    provider: 'anthropic',
    description:
      'Deepest Anthropic architecture and multi-step engineering model with extended reasoning (BYOK).',
    contextWindow: 1_000_000,
    capabilities: ['text', 'vision', 'file-input', 'tools', 'reasoning'],
    tier: 'flagship',
    sponsoredEligible: false,
    inputCostPerMillion: 4.0,
    outputCostPerMillion: 20.0,
  },
] as const;

const MODEL_BY_ID = new Map<string, ModelDefinition>(
  MODEL_CATALOG.map((model) => [model.id, model]),
);

const MODEL_BY_DIRECT_ID = new Map<string, ModelDefinition>(
  MODEL_CATALOG.filter((m) => m.openaiDirectId).map((model) => [
    model.openaiDirectId as string,
    model,
  ]),
);

const DIRECT_OPENAI_PREFIX_RE = /^(gpt-|o[134](?:-|$)|chatgpt-|whisper-|tts-|dall-e-)/i;

/** Look up a curated model definition by Gateway ID or direct OpenAI ID. */
export function getModelDefinition(id?: string | null): ModelDefinition | undefined {
  if (!id) {
    return undefined;
  }
  const normalized = id.trim();
  return MODEL_BY_ID.get(normalized) ?? MODEL_BY_DIRECT_ID.get(normalized);
}

/** Check whether a model ID targets OpenAI (either `openai/...` or unprefixed OpenAI ID). */
export function isOpenAIModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('openai/')) {
    return true;
  }
  if (normalized.includes('/')) {
    return false;
  }
  return DIRECT_OPENAI_PREFIX_RE.test(normalized);
}

/** Check whether a model ID targets Anthropic (`anthropic/...`). */
export function isAnthropicModelId(modelId: string): boolean {
  return modelId.trim().startsWith('anthropic/');
}

/** Check whether a model ID belongs to the enabled OpenAI + Anthropic provider allowlist. */
export function isAllowedProviderModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  if (!normalized) {
    return false;
  }
  return isAnthropicModelId(normalized) || isOpenAIModelId(normalized);
}

/** Check whether a model ID is eligible on host-sponsored tiers (Claude Haiku 5.5 or GPT-6 Luna). */
export function isSponsoredModelId(modelId?: string | null): boolean {
  const normalized = modelId?.trim();
  if (!normalized) {
    return false;
  }
  if (SPONSORED_MODEL_SET.has(normalized)) {
    return true;
  }
  return normalized === stripProviderPrefix(FAST_OPENAI_MODEL_ID);
}

/**
 * Clamp a requested model ID to the OpenAI + Anthropic allowlist for user-billed Gateway calls.
 */
export function resolveAllowedProviderModelId(
  requestedModelId?: string | null,
  fallbackModelId = DEFAULT_MODEL_ID,
): { modelId: string; clamped: boolean; reason?: string } {
  const trimmed = requestedModelId?.trim();
  if (!trimmed) {
    return { modelId: fallbackModelId, clamped: false };
  }
  if (isAnthropicModelId(trimmed)) {
    return { modelId: trimmed, clamped: false };
  }
  if (isOpenAIModelId(trimmed)) {
    return {
      modelId: trimmed.startsWith('openai/') ? trimmed : `openai/${trimmed}`,
      clamped: false,
    };
  }
  return {
    modelId: fallbackModelId,
    clamped: true,
    reason: `Only OpenAI and Anthropic models are enabled. Mapped ${trimmed} to ${fallbackModelId}.`,
  };
}

/**
 * Clamp any requested model ID on host-sponsored tiers strictly to
 * `anthropic/claude-haiku-5.5` or `openai/gpt-6-luna`.
 */
export function resolveSponsoredModelId(
  requestedModelId?: string | null,
  options?: { openaiOnly?: boolean },
): { modelId: string; clamped: boolean; reason?: string } {
  const trimmed = requestedModelId?.trim();

  if (options?.openaiOnly) {
    const isExactLuna =
      !trimmed ||
      trimmed === FAST_OPENAI_MODEL_ID ||
      trimmed === stripProviderPrefix(FAST_OPENAI_MODEL_ID);
    return {
      modelId: FAST_OPENAI_MODEL_ID,
      clamped: !isExactLuna,
      reason: isExactLuna
        ? undefined
        : `Sponsored demo mode is limited to Claude Haiku 5.5 and GPT-6 Luna. Mapped ${trimmed} to ${FAST_OPENAI_MODEL_ID} — add your own API key in Settings to unlock all OpenAI & Anthropic models.`,
    };
  }

  if (!trimmed) {
    return { modelId: DEFAULT_SPONSORED_MODEL_ID, clamped: false };
  }

  if (trimmed === FAST_MODEL_ID) {
    return { modelId: FAST_MODEL_ID, clamped: false };
  }

  if (trimmed === FAST_OPENAI_MODEL_ID || trimmed === stripProviderPrefix(FAST_OPENAI_MODEL_ID)) {
    return { modelId: FAST_OPENAI_MODEL_ID, clamped: false };
  }

  const target = isAnthropicModelId(trimmed) ? FAST_MODEL_ID : FAST_OPENAI_MODEL_ID;
  return {
    modelId: target,
    clamped: true,
    reason: `Sponsored demo mode is limited to GPT-6 Luna and Claude Haiku 5.5. Mapped ${trimmed} to ${target} — add your own API key in Settings to unlock all OpenAI & Anthropic models.`,
  };
}

/** Strip a leading `provider/` prefix from a Gateway model ID. */
export function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf('/');
  return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}

/**
 * Convert any model ID into a direct OpenAI API model ID when routing via `OPENAI_API_KEY`.
 * - `openai/gpt-6.2-sol` -> `gpt-6.2-sol`
 * - `gpt-5.4` -> `gpt-5.4`
 * - Non-OpenAI models -> gracefully mapped by tier (`gpt-6-luna` for fast, `gpt-6.2-sol` otherwise).
 */
export function toOpenAIDirectModelId(modelId?: string | null): string {
  if (!modelId?.trim()) {
    return stripProviderPrefix(DEFAULT_OPENAI_MODEL_ID);
  }

  const trimmed = modelId.trim();
  const catalogEntry = getModelDefinition(trimmed);

  if (catalogEntry?.openaiDirectId) {
    return catalogEntry.openaiDirectId;
  }

  if (trimmed.startsWith('openai/')) {
    return trimmed.slice('openai/'.length);
  }

  if (!trimmed.includes('/') && DIRECT_OPENAI_PREFIX_RE.test(trimmed)) {
    return trimmed;
  }

  if (catalogEntry?.tier === 'fast' || /haiku|flash|mini|lite|nano/i.test(trimmed)) {
    return stripProviderPrefix(FAST_OPENAI_MODEL_ID);
  }

  if (catalogEntry?.tier === 'coding' || /codex|coder/i.test(trimmed)) {
    return 'gpt-5.3-codex';
  }

  return stripProviderPrefix(DEFAULT_OPENAI_MODEL_ID);
}

/**
 * Coerce any requested model ID to a verified OpenAI Realtime model ID on Vercel AI Gateway.
 */
export function toGatewayRealtimeModelId(modelId?: string | null): string {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return REALTIME_MODEL_ID;
  }
  if (GATEWAY_REALTIME_MODEL_SET.has(trimmed)) {
    return trimmed;
  }
  return REALTIME_MODEL_ID;
}

/**
 * Coerce any requested model ID to a verified direct OpenAI Realtime model ID (`gpt-realtime`).
 */
export function toOpenAIDirectRealtimeModelId(modelId?: string | null): string {
  const trimmed = modelId?.trim();
  if (trimmed === REALTIME_OPENAI_DIRECT_MODEL_ID || trimmed === 'openai/gpt-realtime') {
    return REALTIME_OPENAI_DIRECT_MODEL_ID;
  }
  return REALTIME_OPENAI_DIRECT_MODEL_ID;
}

/** Group curated catalog entries by provider family (Anthropic & OpenAI) for model picker UIs. */
export function getModelsByProvider(): Record<
  Exclude<ModelProviderFamily, 'custom'>,
  ModelDefinition[]
> {
  const grouped: Record<Exclude<ModelProviderFamily, 'custom'>, ModelDefinition[]> = {
    openai: [],
    anthropic: [],
  };

  for (const model of MODEL_CATALOG) {
    if (model.provider !== 'custom') {
      grouped[model.provider].push(model);
    }
  }

  return grouped;
}

/** Estimate USD cost for token usage if the model has pricing metadata in the catalog. */
export function estimateTokenCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const model = getModelDefinition(modelId);
  if (
    !model ||
    model.inputCostPerMillion === undefined ||
    model.outputCostPerMillion === undefined
  ) {
    return undefined;
  }

  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * model.inputCostPerMillion;
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * model.outputCostPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
