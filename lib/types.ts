/**
 * Shared TypeScript contracts for Web ADE.
 * All server routes, agent harnesses, database adapters, and UI components build against these types.
 */

export type HarnessMode = 'ai-sdk' | 'fx' | 'workflow';

export type BillingSource =
  | 'custom-endpoint'
  | 'user-byok-gateway'
  | 'user-byok-openai'
  | 'user-vercel-oauth'
  | 'sponsor-openai'
  | 'sponsor-gateway'
  | 'vercel-oidc'
  | 'unconfigured';

export interface BillingSourceInfo {
  source: BillingSource;
  label: string;
  providerName: string;
  isUserBilled: boolean;
  creditsRemaining?: number | null;
  detail?: string;
}

export type ProviderOverrideMode =
  | 'auto'
  | 'custom-openai-compatible'
  | 'byok-gateway'
  | 'byok-openai';

export interface ProviderOverrideConfig {
  mode?: ProviderOverrideMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  githubToken?: string;
}

export type ModelCapability =
  | 'text'
  | 'vision'
  | 'file-input'
  | 'tools'
  | 'reasoning'
  | 'image-gen'
  | 'audio'
  | 'realtime';

export type ModelProviderFamily = 'anthropic' | 'openai' | 'custom';

export interface ModelDefinition {
  id: string;
  /** Direct OpenAI model id when routing via `OPENAI_API_KEY` instead of AI Gateway. */
  openaiDirectId?: string;
  name: string;
  provider: ModelProviderFamily;
  description: string;
  contextWindow: number;
  capabilities: ModelCapability[];
  tier: 'flagship' | 'balanced' | 'fast' | 'coding';
  /** True when available on host-sponsored tiers without user BYOK credentials. */
  sponsoredEligible?: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export type WorkbenchTab = 'preview' | 'browser' | 'terminal' | 'files' | 'genui' | 'trace';

export type BrowserStreamMode = 'preview' | 'screen-relay' | 'agent-browser' | 'snapshot';

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserControlState {
  mode: BrowserStreamMode;
  url: string;
  title?: string;
  isConnected: boolean;
  isHumanInControl: boolean;
  sandboxId?: string;
  streamUrl?: string;
  grantToken?: string;
  previewUrl?: string;
  lastScreenshotUrl?: string;
  viewport: BrowserViewport;
  statusMessage?: string;
}

export type ArtifactKind = 'code' | 'document' | 'html' | 'genui' | 'diff';

export interface ArtifactRecord {
  id: string;
  chatId?: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  language?: string;
  version: number;
  /** Optional `@json-render/core` Spec payload when `kind === 'genui'`. */
  spec?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  language?: string;
  updatedAt?: string;
  children?: WorkspaceFileEntry[];
}

export type ChatVisibility = 'private' | 'public';

export interface ChatSummary {
  id: string;
  title: string;
  modelId: string;
  harnessMode: HarnessMode;
  visibility: ChatVisibility;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  lastMessagePreview?: string;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  estimatedCostUsd?: number;
}

export interface MessageMetadata {
  createdAt?: string;
  modelId?: string;
  harnessMode?: HarnessMode;
  billingSource?: BillingSource;
  billingLabel?: string;
  reasoningDurationMs?: number;
  latencyMs?: number;
  usage?: TokenUsageSummary;
  checkpointId?: string;
  parentMessageId?: string | null;
  branchIndex?: number;
  branchCount?: number;
}

export type TraceSpanKind =
  | 'llm'
  | 'reasoning'
  | 'tool'
  | 'subagent'
  | 'sandbox'
  | 'browser'
  | 'workflow-step'
  | 'ui-action';

export type TraceSpanStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'awaiting-approval'
  | 'denied';

export interface TraceSpan {
  id: string;
  parentId?: string | null;
  name: string;
  kind: TraceSpanKind;
  status: TraceSpanStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  modelId?: string;
  toolName?: string;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
  tokens?: Partial<TokenUsageSummary>;
  metadata?: Record<string, unknown>;
}

export type AstryxPalette = 'neutral' | 'stone' | 'matcha' | 'obsidian';

export type ThemeMode = 'system' | 'light' | 'dark';

export type VoiceMode = 'off' | 'dictate' | 'speak' | 'realtime';

export type UiAgentAction =
  | 'set-theme'
  | 'set-palette'
  | 'set-workbench-open'
  | 'set-workbench-tab'
  | 'set-model'
  | 'set-harness'
  | 'open-command-palette'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'browser-navigate'
  | 'browser-take-control'
  | 'browser-release-control'
  | 'terminal-run'
  | 'new-chat'
  | 'ui-sdk-act';

export interface UiAgentCommand {
  id?: string;
  ref?: string;
  action: UiAgentAction;
  args?: Record<string, unknown>;
  requiresApproval?: boolean;
  reason?: string;
}

export interface UiAgentComponentSummary {
  ref: string;
  role?: string;
  label?: string;
  value?: unknown;
  actions: string[];
}

export interface UiAgentSnapshot {
  route: string;
  theme: ThemeMode;
  palette: AstryxPalette;
  modelId: string;
  harnessMode: HarnessMode;
  workbenchOpen: boolean;
  activeTab: WorkbenchTab;
  sidebarOpen: boolean;
  browserMode: BrowserStreamMode;
  components: UiAgentComponentSummary[];
}

export interface AttachmentItem {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  url: string;
  previewUrl?: string;
}

export type ApprovalRiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  title: string;
  description: string;
  riskLevel: ApprovalRiskLevel;
  input: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
}

export interface ClarifyingQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarifyingQuestion {
  id: string;
  prompt: string;
  multiSelect?: boolean;
  options: ClarifyingQuestionOption[];
}

export type SandboxTier = 'just-bash' | 'vercel-sandbox' | 'remote-agent-browser';

export interface SandboxSessionInfo {
  id: string;
  tier: SandboxTier;
  status: 'idle' | 'starting' | 'ready' | 'stopped' | 'error';
  previewUrl?: string;
  relayUrl?: string;
  browserStreamUrl?: string;
  createdAt: string;
}

export interface AppPreferences {
  theme: ThemeMode;
  palette: AstryxPalette;
  modelId: string;
  harnessMode: HarnessMode;
  voiceMode: VoiceMode;
  uiBridgeEnabled: boolean;
  autoApproveReadTools: boolean;
  workbenchWidthPct: number;
}

export interface ChatRequestBody {
  id?: string;
  messages: unknown[];
  modelId?: string;
  harnessMode?: HarnessMode;
  providerOverride?: ProviderOverrideConfig;
  sandboxId?: string;
  enableGenUi?: boolean;
  enableUiBridge?: boolean;
  enableGithubTools?: boolean;
  uiSnapshot?: UiAgentSnapshot;
}
