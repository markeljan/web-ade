'use client';

import { useChat } from '@ai-sdk/react';
import { SPEC_DATA_PART_TYPE } from '@json-render/core';
import type { Spec } from '@json-render/react';
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import {
  ArrowDown,
  BarChart3,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  FileText,
  Globe,
  ImageIcon,
  Pencil,
  RefreshCw,
  Sparkles,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Composer, type ComposerSubmitPayload } from '@/components/ade/composer';
import type { ClientProviderSettings } from '@/components/ade/settings-dialog';
import { AskUserCard } from '@/components/ai-elements/ask-user-card';
import { CheckpointDivider } from '@/components/ai-elements/checkpoint-divider';
import { ConfirmationCard } from '@/components/ai-elements/confirmation-card';
import { MessageRenderer } from '@/components/ai-elements/message-renderer';
import type { QueuedPromptItem } from '@/components/ai-elements/prompt-queue';
import { ReasoningBlock } from '@/components/ai-elements/reasoning-block';
import { type SourceItem, SourcesBar } from '@/components/ai-elements/sources-bar';
import { SuggestionGrid, type SuggestionItem } from '@/components/ai-elements/suggestion-grid';
import { ToolCard, type ToolCardState } from '@/components/ai-elements/tool-card';
import { TracePill } from '@/components/ai-elements/trace-pill';
import { buildSpecFromParts, GenUIRenderer } from '@/components/genui/genui-renderer';
import type { GenUiActionHandler } from '@/components/genui/registry';
import { Button } from '@/components/ui/button';
import type {
  ArtifactRecord,
  BillingSourceInfo,
  ClarifyingQuestion,
  HarnessMode,
  MessageMetadata,
  ModelDefinition,
  SandboxTier,
  TokenUsageSummary,
  TraceSpan,
  TraceSpanKind,
  UiAgentCommand,
  WorkbenchTab,
  WorkspaceFileEntry,
} from '@/lib/types';
import { useUiAgent } from '@/lib/ui-agent/bridge';
import { cn, generateId } from '@/lib/utils';

export type AdeUIMessage = UIMessage<MessageMetadata>;

export interface ChatPaneProps {
  chatId: string;
  initialMessages: AdeUIMessage[];
  initialVotes?: Record<string, boolean>;
  models: ModelDefinition[];
  modelId: string;
  onChangeModel: (modelId: string) => void;
  harnessMode: HarnessMode;
  onChangeHarness: (harness: HarnessMode) => void;
  sandboxTier: SandboxTier;
  billingInfo: BillingSourceInfo;
  providerSettings: ClientProviderSettings;
  workspaceFiles: WorkspaceFileEntry[];
  externalPromptQueue?: { id: string; text: string } | null;
  onConsumeExternalPrompt?: (id: string) => void;
  onOpenSettings: (tab?: 'providers' | 'harnesses' | 'appearance') => void;
  onOpenRealtimeVoice: () => void;
  onOpenWorkbench: (tab: WorkbenchTab, target?: string) => void;
  onArtifactDetected: (artifact: ArtifactRecord, autoOpen?: boolean) => void;
  onBrowserToolActivity: (info: { url?: string; title?: string; mode?: string }) => void;
  onWorkspaceMutated: () => void;
  onPromoteGenUiSpec: (spec: Spec, title?: string) => void;
  onGenUiAction: GenUiActionHandler;
  onTraceSpansChange: (spans: TraceSpan[]) => void;
  usage?: TokenUsageSummary | null;
  onUsageChange: (usage: TokenUsageSummary | null) => void;
  onStreamingChange: (isStreaming: boolean) => void;
  onBillingMetadataUpdate?: (info: Partial<BillingSourceInfo>) => void;
  onChatTitleHint?: (firstPrompt: string) => void;
  onNewChat: () => void;
}

interface QueuedFullPayload extends QueuedPromptItem {
  payload: ComposerSubmitPayload;
}

const STARTER_PROMPTS: SuggestionItem[] = [
  {
    id: 'starter-fx0-preview',
    title: 'Build an interactive web app',
    description:
      'Create a polished single-file HTML/CSS/JS Pomodoro & ambient focus timer and render it live in the Preview pane.',
    prompt:
      'Create an interactive, Astryx-styled Pomodoro focus timer and ambient waveform visualizer as a single-file HTML artifact using create_artifact (kind: "html") so I can interact with it live in the Preview tab.',
    badge: 'Live Preview',
    icon: <Sparkles className="size-3.5" />,
    targetTab: 'preview',
  },
  {
    id: 'starter-genui',
    title: 'Stream a live metrics dashboard',
    description:
      'Render an interactive json-render dashboard with KPI cards, Recharts comparison chart, and sortable table.',
    prompt:
      'Stream an interactive json-render Generative UI dashboard comparing 2026 frontier AI models (Claude Sonnet 5.5, GPT-6.2 Sol, Gemini 4 Carbon, Grok 4.7) across context window, latency, and cost per 1M tokens with a MetricGrid, Bar Chart, and searchable DataTable.',
    badge: 'json-render',
    icon: <BarChart3 className="size-3.5" />,
    targetTab: 'genui',
  },
  {
    id: 'starter-terminal',
    title: 'Run a coding task in @wterm',
    description:
      'Inspect workspace files, author a TypeScript module in the virtual sandbox, and execute tests via bash-tool.',
    prompt:
      'List the files in my workspace, write a clean TypeScript rate-limiter module in src/rate-limiter.ts, and run a quick verification script via bash to prove it works.',
    badge: 'just-bash',
    icon: <Terminal className="size-3.5" />,
    targetTab: 'terminal',
  },
  {
    id: 'starter-browser',
    title: 'Browse & inspect a live site',
    description:
      'Open a website in the embedded agent-browser pane, inspect its accessibility snapshot, and summarize key links.',
    prompt:
      'Open https://news.ycombinator.com using browser_open, inspect the snapshot, and give me a concise executive digest of the top 5 engineering stories right now.',
    badge: 'agent-browser',
    icon: <Globe className="size-3.5" />,
    targetTab: 'browser',
  },
  {
    id: 'starter-ui-bridge',
    title: 'Operate the ADE UI with AI',
    description:
      'Watch the assistant inspect live @ui-sdk/react/agent targets and control palette, theme, and Workbench panes.',
    prompt:
      'Call ui_snapshot to inspect my live Web ADE workspace controls, then propose a ui_act command to switch to the Matcha Astryx palette, open the Workbench, and jump to the Trace Waterfall tab.',
    badge: '@ui-sdk/agent',
    icon: <Wand2 className="size-3.5" />,
    targetTab: 'trace',
  },
  {
    id: 'starter-image',
    title: 'Generate & critique visuals',
    description:
      'Synthesize an original architectural studio illustration with multimodal image generation.',
    prompt:
      'Generate a serene architectural concept illustration of a sunlit minimalist glass engineering studio overlooking Kyoto cedar gardens using generate_image (aspectRatio: "16:9"), then describe the lighting and composition.',
    badge: 'Multimodal',
    icon: <ImageIcon className="size-3.5" />,
  },
];

function getHarnessEndpoint(harness: HarnessMode): string {
  if (harness === 'fx') return '/api/chat/fx';
  if (harness === 'workflow') return '/api/workflow';
  return '/api/chat';
}

function buildProviderOverridePayload(settings: ClientProviderSettings) {
  const out: Record<string, string> = {};
  if (settings.mode && settings.mode !== 'auto') out.mode = settings.mode;
  if (settings.customBaseUrl.trim()) {
    out.baseUrl = settings.customBaseUrl.trim();
    out.customBaseUrl = settings.customBaseUrl.trim();
  }
  if (settings.customApiKey.trim()) {
    out.customApiKey = settings.customApiKey.trim();
  }
  if (settings.customModel.trim()) {
    out.model = settings.customModel.trim();
    out.customModel = settings.customModel.trim();
  }
  if (settings.byokApiKey.trim()) {
    out.byokApiKey = settings.byokApiKey.trim();
  }
  if (settings.githubToken.trim()) {
    out.githubToken = settings.githubToken.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function inferToolSpanKind(toolName: string): TraceSpanKind {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('browser_')) return 'browser';
  if (lower === 'bash' || lower.includes('shell') || lower.includes('file')) {
    return 'sandbox';
  }
  if (lower.startsWith('ui_')) return 'ui-action';
  return 'tool';
}

function extractPlainTextFromMessage(msg: AdeUIMessage): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

export function ChatPane({
  chatId,
  initialMessages,
  initialVotes = {},
  models,
  modelId,
  onChangeModel,
  harnessMode,
  onChangeHarness,
  sandboxTier,
  billingInfo,
  providerSettings,
  workspaceFiles,
  externalPromptQueue,
  onConsumeExternalPrompt,
  onOpenSettings,
  onOpenRealtimeVoice,
  onOpenWorkbench,
  onArtifactDetected,
  onBrowserToolActivity,
  onWorkspaceMutated,
  onPromoteGenUiSpec,
  onGenUiAction,
  onTraceSpansChange,
  usage,
  onUsageChange,
  onStreamingChange,
  onBillingMetadataUpdate,
  onChatTitleHint,
  onNewChat,
}: ChatPaneProps) {
  const uiAgent = useUiAgent();

  const [inputValue, setInputValue] = useState('');
  const [votes, setVotes] = useState<Record<string, boolean>>(initialVotes);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedFullPayload[]>([]);
  const [branchesByUserMsgId, setBranchesByUserMsgId] = useState<
    Record<string, { variants: AdeUIMessage[][]; activeIdx: number }>
  >({});

  // Scroll stickiness
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Deduplication sets for client tool execution & side-effects
  const executedClientToolsRef = useRef<Set<string>>(new Set());
  const processedToolOutputsRef = useRef<Set<string>>(new Set());
  const sessionApprovedToolsRef = useRef<Set<string>>(new Set());
  const spanTimersRef = useRef<Map<string, { startedAt: number; endedAt?: number }>>(new Map());

  // Keep latest dynamic request config in ref to avoid stale DefaultChatTransport body
  const requestConfigRef = useRef({
    chatId,
    modelId,
    harnessMode,
    sandboxTier,
    providerSettings,
  });
  requestConfigRef.current = {
    chatId,
    modelId,
    harnessMode,
    sandboxTier,
    providerSettings,
  };

  const uiAgentRef = useRef(uiAgent);
  uiAgentRef.current = uiAgent;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AdeUIMessage>({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ id, messages, body }) => {
          const cfg = requestConfigRef.current;
          const override = buildProviderOverridePayload(cfg.providerSettings);
          const snap = uiAgentRef.current.snapshot();
          return {
            api: getHarnessEndpoint(cfg.harnessMode),
            body: {
              ...(body && typeof body === 'object' ? body : {}),
              id: cfg.chatId || id,
              messages,
              modelId: cfg.modelId,
              harnessMode: cfg.harnessMode,
              sandboxTier: cfg.sandboxTier,
              ...(override ? { providerOverride: override } : {}),
              ...(cfg.providerSettings.customBaseUrl.trim()
                ? { customBaseUrl: cfg.providerSettings.customBaseUrl.trim() }
                : {}),
              ...(cfg.providerSettings.customApiKey.trim()
                ? { customApiKey: cfg.providerSettings.customApiKey.trim() }
                : {}),
              ...(cfg.providerSettings.customModel.trim()
                ? { customModel: cfg.providerSettings.customModel.trim() }
                : {}),
              ...(cfg.providerSettings.byokApiKey.trim()
                ? { byokApiKey: cfg.providerSettings.byokApiKey.trim() }
                : {}),
              ...(cfg.providerSettings.githubToken.trim()
                ? { githubToken: cfg.providerSettings.githubToken.trim() }
                : {}),
              enableGenUi: true,
              enableUiBridge: true,
              uiActRequireApproval: uiAgentRef.current.requireApproval,
              enableGithubTools: Boolean(cfg.providerSettings.githubToken.trim()),
              uiSnapshot: snap,
            },
          };
        },
      }),
    [],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    clearError,
    addToolOutput,
    addToolApprovalResponse,
  } = useChat<AdeUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: ({ messages: currentMsgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMsgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({
        messages: currentMsgs,
      }),
    onError: (err) => {
      toast.error(err.message || 'Chat request failed');
    },
  });

  const isStreaming = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    onStreamingChange(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Drain queued prompts automatically once the stream settles
  useEffect(() => {
    if (isStreaming || queuedPrompts.length === 0) return;
    const [next, ...rest] = queuedPrompts;
    if (!next) return;
    setQueuedPrompts(rest);
    void sendMessage({
      text: next.payload.text || 'Attached files',
      ...(next.payload.files.length > 0 ? { files: next.payload.files } : {}),
    });
  }, [isStreaming, queuedPrompts, sendMessage]);

  // Consume external prompts triggered from Workbench (e.g. "Ask AI to edit selection", BrowserPane, GenUI action)
  useEffect(() => {
    if (!externalPromptQueue) return;
    onConsumeExternalPrompt?.(externalPromptQueue.id);
    if (isStreaming) {
      setQueuedPrompts((prev) => [
        ...prev,
        {
          id: externalPromptQueue.id,
          text: externalPromptQueue.text,
          createdAt: Date.now(),
          payload: {
            text: externalPromptQueue.text,
            files: [],
            attachments: [],
          },
        },
      ]);
      toast.info('Added request to prompt queue');
    } else {
      if (messages.length === 0) {
        onChatTitleHint?.(externalPromptQueue.text);
      }
      void sendMessage({ text: externalPromptQueue.text });
    }
  }, [
    externalPromptQueue,
    onConsumeExternalPrompt,
    isStreaming,
    messages.length,
    onChatTitleHint,
    sendMessage,
  ]);

  const executeUiActToolCall = useCallback(
    async (toolCallId: string, input: unknown) => {
      if (executedClientToolsRef.current.has(toolCallId)) return;
      executedClientToolsRef.current.add(toolCallId);

      const rawInput = (input ?? {}) as {
        commands?: UiAgentCommand[];
        reason?: string;
      };
      const commands = Array.isArray(rawInput.commands) ? rawInput.commands : [];

      try {
        const outcome = await uiAgentRef.current.act(commands, {
          source: 'agent',
          bypassApproval: true,
        });
        await addToolOutput({
          tool: 'ui_act',
          toolCallId,
          output: outcome,
        });
        if (outcome.ok) {
          toast.success(
            `UI Bridge executed ${outcome.executed} UI action${outcome.executed === 1 ? '' : 's'}`,
          );
        }
      } catch (err) {
        await addToolOutput({
          tool: 'ui_act',
          toolCallId,
          state: 'output-error',
          errorText: err instanceof Error ? err.message : 'UI Bridge action failed',
        });
      }
    },
    [addToolOutput],
  );

  // Auto-execute read-only `ui_snapshot` and honor explicit session-wide approvals without bypassing Sentinel gates
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of msg.parts) {
        if (!isToolUIPart(part)) continue;
        const toolName =
          part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, '');
        const toolCallId = part.toolCallId;

        // Auto-approve only when the user explicitly clicked "Always Allow for Session" earlier
        if (
          part.state === 'approval-requested' &&
          part.approval?.id &&
          sessionApprovedToolsRef.current.has(toolName)
        ) {
          if (toolName === 'ui_act') {
            void executeUiActToolCall(toolCallId, part.input);
          } else {
            const approvalKey = `approve:${part.approval.id}`;
            if (!executedClientToolsRef.current.has(approvalKey)) {
              executedClientToolsRef.current.add(approvalKey);
              void addToolApprovalResponse({
                id: part.approval.id,
                approved: true,
                reason: 'Auto-approved for this session by user preference.',
              });
            }
          }
          continue;
        }

        // Execute read-only `ui_snapshot` immediately on client
        if (
          toolName === 'ui_snapshot' &&
          part.state === 'input-available' &&
          !executedClientToolsRef.current.has(toolCallId)
        ) {
          executedClientToolsRef.current.add(toolCallId);
          const snap = uiAgentRef.current.snapshot();
          void addToolOutput({
            tool: 'ui_snapshot',
            toolCallId,
            output: snap,
          });
        }
      }
    }
  }, [messages, addToolOutput, addToolApprovalResponse, executeUiActToolCall]);

  // Keep observer callbacks in a ref so parent re-renders never trigger feedback loops
  const observerCallbacksRef = useRef({
    onArtifactDetected,
    onBillingMetadataUpdate,
    onBrowserToolActivity,
    onTraceSpansChange,
    onUsageChange,
    onWorkspaceMutated,
  });
  observerCallbacksRef.current = {
    onArtifactDetected,
    onBillingMetadataUpdate,
    onBrowserToolActivity,
    onTraceSpansChange,
    onUsageChange,
    onWorkspaceMutated,
  };
  const lastSpansSignatureRef = useRef<string>('');
  const lastBillingKeyRef = useRef<string>('');
  const lastUsageKeyRef = useRef<string>('');

  // Observe completed tool outputs & metadata to sync Workbench artifacts, browser, workspace files, billing badge, usage, and trace waterfall
  useEffect(() => {
    const callbacks = observerCallbacksRef.current;
    const builtSpans: TraceSpan[] = [];
    let latestUsage: TokenUsageSummary | null = null;
    let latestBilling: { source: BillingSourceInfo['source']; label?: string } | null = null;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const meta = msg.metadata;

      if (meta?.usage) {
        latestUsage = meta.usage;
      }
      if (meta?.billingSource) {
        latestBilling = {
          source: meta.billingSource,
          label: meta.billingLabel,
        };
      }

      const turnSpanId = `turn-${msg.id}`;
      let turnTimer = spanTimersRef.current.get(turnSpanId);
      if (!turnTimer) {
        turnTimer = {
          startedAt: meta?.createdAt ? new Date(meta.createdAt).getTime() : Date.now(),
        };
        spanTimersRef.current.set(turnSpanId, turnTimer);
      }
      const isLastMsg = msg.id === messages[messages.length - 1]?.id;
      const turnRunning = isLastMsg && isStreaming;
      if (!turnRunning && !turnTimer.endedAt) {
        turnTimer.endedAt = meta?.latencyMs ? turnTimer.startedAt + meta.latencyMs : Date.now();
      }

      builtSpans.push({
        id: turnSpanId,
        parentId: null,
        name: meta?.modelId ? `Turn · ${meta.modelId}` : 'Assistant Turn',
        kind: 'llm',
        status: turnRunning ? 'running' : 'completed',
        startedAt: turnTimer.startedAt,
        endedAt: turnTimer.endedAt,
        durationMs:
          meta?.latencyMs ??
          (turnTimer.endedAt ? Math.max(10, turnTimer.endedAt - turnTimer.startedAt) : undefined),
        modelId: meta?.modelId ?? modelId,
        tokens: meta?.usage,
      });

      msg.parts.forEach((part, idx) => {
        if (part.type === 'reasoning') {
          const rId = `rsn-${msg.id}-${idx}`;
          let rTimer = spanTimersRef.current.get(rId);
          if (!rTimer) {
            rTimer = { startedAt: turnTimer.startedAt + 10 };
            spanTimersRef.current.set(rId, rTimer);
          }
          const rRunning = part.state === 'streaming';
          if (!rRunning && !rTimer.endedAt) {
            rTimer.endedAt = meta?.reasoningDurationMs
              ? rTimer.startedAt + meta.reasoningDurationMs
              : Date.now();
          }
          builtSpans.push({
            id: rId,
            parentId: turnSpanId,
            name: 'Reasoning',
            kind: 'reasoning',
            status: rRunning ? 'running' : 'completed',
            startedAt: rTimer.startedAt,
            endedAt: rTimer.endedAt,
            durationMs:
              meta?.reasoningDurationMs ??
              (rTimer.endedAt ? rTimer.endedAt - rTimer.startedAt : undefined),
            outputPreview: part.text.slice(0, 400),
          });
        } else if (isToolUIPart(part)) {
          const toolName =
            part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, '');
          const tId = `tool-${part.toolCallId}`;
          let tTimer = spanTimersRef.current.get(tId);
          if (!tTimer) {
            tTimer = { startedAt: Date.now() };
            spanTimersRef.current.set(tId, tTimer);
          }

          const isDone =
            part.state === 'output-available' ||
            part.state === 'output-error' ||
            part.state === 'output-denied';
          if (isDone && !tTimer.endedAt) {
            tTimer.endedAt = Date.now();
          }

          builtSpans.push({
            id: tId,
            parentId: turnSpanId,
            name: toolName,
            toolName,
            kind: inferToolSpanKind(toolName),
            status:
              part.state === 'output-available'
                ? 'completed'
                : part.state === 'output-error'
                  ? 'error'
                  : part.state === 'output-denied'
                    ? 'denied'
                    : part.state === 'approval-requested'
                      ? 'awaiting-approval'
                      : 'running',
            startedAt: tTimer.startedAt,
            endedAt: tTimer.endedAt,
            durationMs: tTimer.endedAt ? Math.max(5, tTimer.endedAt - tTimer.startedAt) : undefined,
            inputPreview:
              part.input !== undefined
                ? JSON.stringify(part.input, null, 2).slice(0, 600)
                : undefined,
            outputPreview:
              part.state === 'output-available' && part.output !== undefined
                ? JSON.stringify(part.output, null, 2).slice(0, 600)
                : undefined,
            error: part.state === 'output-error' ? part.errorText : undefined,
          });

          // Side-effects on completed tools (once per toolCallId)
          if (
            part.state === 'output-available' &&
            !processedToolOutputsRef.current.has(part.toolCallId)
          ) {
            processedToolOutputsRef.current.add(part.toolCallId);
            const out =
              part.output && typeof part.output === 'object'
                ? (part.output as Record<string, unknown>)
                : null;

            if (
              (toolName === 'create_artifact' ||
                toolName === 'update_artifact' ||
                toolName === 'write_html_preview') &&
              out?.artifact &&
              typeof out.artifact === 'object'
            ) {
              callbacks.onArtifactDetected(out.artifact as ArtifactRecord, true);
              if (toolName === 'write_html_preview') {
                callbacks.onWorkspaceMutated();
              }
            } else if (toolName === 'write_html_preview') {
              callbacks.onWorkspaceMutated();
            } else if (toolName.startsWith('browser_') && out) {
              callbacks.onBrowserToolActivity({
                url: typeof out.url === 'string' ? out.url : undefined,
                title: typeof out.title === 'string' ? out.title : undefined,
                mode: typeof out.mode === 'string' ? out.mode : undefined,
              });
            } else if (
              toolName === 'bash' ||
              toolName === 'shell' ||
              toolName === 'write_file' ||
              toolName === 'edit_file'
            ) {
              callbacks.onWorkspaceMutated();
            }
          }
        }
      });
    }

    const spansSig = builtSpans.map((s) => `${s.id}:${s.status}:${s.durationMs ?? ''}`).join('|');
    if (spansSig !== lastSpansSignatureRef.current) {
      lastSpansSignatureRef.current = spansSig;
      callbacks.onTraceSpansChange(builtSpans);
    }

    if (latestBilling) {
      const billingKey = `${latestBilling.source}:${latestBilling.label ?? ''}`;
      if (billingKey !== lastBillingKeyRef.current) {
        lastBillingKeyRef.current = billingKey;
        callbacks.onBillingMetadataUpdate?.(latestBilling);
      }
    }

    if (latestUsage) {
      const usageKey = `${latestUsage.inputTokens}:${latestUsage.outputTokens}:${latestUsage.totalTokens}`;
      if (usageKey !== lastUsageKeyRef.current) {
        lastUsageKeyRef.current = usageKey;
        callbacks.onUsageChange(latestUsage);
      }
    }
  }, [messages, isStreaming, modelId]);

  // Sticky-bottom smart auto-scroll that respects manual scroll-up
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distanceFromBottom < 96);
  }, []);

  useEffect(() => {
    if (!isNearBottom || messages.length === 0) return;
    bottomSentinelRef.current?.scrollIntoView({
      behavior: isStreaming ? 'auto' : 'smooth',
    });
  }, [messages, isNearBottom, isStreaming]);

  const scrollToBottom = () => {
    setIsNearBottom(true);
    bottomSentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Submit handler (supports queuing when streaming)
  const handleComposerSubmit = useCallback(
    (payload: ComposerSubmitPayload) => {
      if (isStreaming) {
        setQueuedPrompts((prev) => [
          ...prev,
          {
            id: generateId('q', 8),
            text: payload.text,
            attachmentCount: payload.attachments.length,
            createdAt: Date.now(),
            payload,
          },
        ]);
        toast.info('Prompt queued — will send automatically when ready');
        return;
      }

      if (messages.length === 0 && payload.text) {
        onChatTitleHint?.(payload.text);
      }

      setIsNearBottom(true);
      void sendMessage({
        text: payload.text || 'Analyze the attached files.',
        ...(payload.files.length > 0 ? { files: payload.files } : {}),
      });
    },
    [isStreaming, messages.length, onChatTitleHint, sendMessage],
  );

  const handleSlashCommand = useCallback(
    (cmd: string): boolean => {
      if (cmd === 'clear') {
        onNewChat();
        return true;
      }
      if (cmd === 'fx') {
        onChangeHarness('fx');
        toast.success('Switched harness to fx (libfx)');
        return true;
      }
      if (cmd === 'workflow') {
        onChangeHarness('workflow');
        toast.success('Switched harness to Workflow 5');
        return true;
      }
      if (cmd === 'terminal') {
        onOpenWorkbench('terminal');
        return false;
      }
      if (cmd === 'browser') {
        onOpenWorkbench('browser');
        return false;
      }
      if (cmd === 'preview') {
        onOpenWorkbench('preview');
        return false;
      }
      if (cmd === 'genui') {
        onOpenWorkbench('genui');
        return false;
      }
      return false;
    },
    [onNewChat, onChangeHarness, onOpenWorkbench],
  );

  // Copy, Vote, TTS Speak, Edit & Branch Regenerate, Checkpoint Rewind
  const handleCopyMessage = async (msg: AdeUIMessage) => {
    const text = extractPlainTextFromMessage(msg);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedId(msg.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleVote = async (messageId: string, isUpvoted: boolean) => {
    setVotes((prev) => ({ ...prev, [messageId]: isUpvoted }));
    try {
      await fetch(`/api/chats/${encodeURIComponent(chatId)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, isUpvoted }),
      });
    } catch {
      // Optimistic state kept gracefully on local/offline sessions
    }
  };

  const handleSpeakMessage = async (msg: AdeUIMessage) => {
    if (speakingId === msg.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      setSpeakingId(null);
      return;
    }

    const text = extractPlainTextFromMessage(msg).slice(0, 3500);
    if (!text) return;
    setSpeakingId(msg.id);

    try {
      const override = buildProviderOverridePayload(providerSettings);
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, providerOverride: override }),
      });
      if (res.ok && res.headers.get('content-type')?.includes('audio')) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setSpeakingId(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setSpeakingId(null);
        };
        await audio.play();
        return;
      }
    } catch {
      // Fall back to browser speechSynthesis
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.onend = () => setSpeakingId(null);
      utter.onerror = () => setSpeakingId(null);
      window.speechSynthesis.speak(utter);
    } else {
      setSpeakingId(null);
      toast.error('Text-to-speech unavailable in this browser.');
    }
  };

  const rewindServerHistory = useCallback(
    async (messageId: string | undefined, inclusive: boolean) => {
      if (!messageId) return;
      try {
        await fetch(`/api/chats/${encodeURIComponent(chatId)}/rewind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, inclusive }),
        });
      } catch {
        // Non-fatal on ephemeral or offline sessions
      }
    },
    [chatId],
  );

  const handleRegenerateWithBranch = useCallback(
    async (assistantIndex: number) => {
      const assistantMsg = messages[assistantIndex];
      const prevUserMsg = messages
        .slice(0, assistantIndex)
        .reverse()
        .find((m) => m.role === 'user');
      if (prevUserMsg && assistantMsg) {
        const currentBranchTail = messages.slice(assistantIndex);
        setBranchesByUserMsgId((prev) => {
          const existing = prev[prevUserMsg.id];
          const variants = existing ? [...existing.variants] : [currentBranchTail];
          if (existing) {
            variants[existing.activeIdx] = currentBranchTail;
          }
          return {
            ...prev,
            [prevUserMsg.id]: {
              variants,
              activeIdx: variants.length,
            },
          };
        });
      }
      await rewindServerHistory(assistantMsg?.id, true);
      void regenerate({ messageId: assistantMsg?.id });
    },
    [messages, regenerate, rewindServerHistory],
  );

  // Sync newly regenerated branch into branch store once settled
  useEffect(() => {
    if (isStreaming) return;
    setBranchesByUserMsgId((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [userMsgId, entry] of Object.entries(prev)) {
        const uIdx = messages.findIndex((m) => m.id === userMsgId);
        if (uIdx === -1) continue;
        const tail = messages.slice(uIdx + 1);
        if (tail.length > 0 && entry.activeIdx >= entry.variants.length) {
          next[userMsgId] = {
            variants: [...entry.variants, tail],
            activeIdx: entry.variants.length,
          };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [isStreaming, messages]);

  const handleSwitchBranch = (userMsgId: string, delta: -1 | 1) => {
    const entry = branchesByUserMsgId[userMsgId];
    if (!entry || entry.variants.length <= 1) return;
    const uIdx = messages.findIndex((m) => m.id === userMsgId);
    if (uIdx === -1) return;

    const currentTail = messages.slice(uIdx + 1);
    const updatedVariants = [...entry.variants];
    updatedVariants[entry.activeIdx] = currentTail;

    const nextIdx = (entry.activeIdx + delta + updatedVariants.length) % updatedVariants.length;
    const nextTail = updatedVariants[nextIdx] ?? [];

    setBranchesByUserMsgId((prev) => ({
      ...prev,
      [userMsgId]: { variants: updatedVariants, activeIdx: nextIdx },
    }));
    setMessages([...messages.slice(0, uIdx + 1), ...nextTail]);
  };

  const handleCommitUserEdit = async (userMsgIndex: number) => {
    const trimmed = editingText.trim();
    const targetMsg = messages[userMsgIndex];
    setEditingMessageId(null);
    if (!trimmed || !targetMsg) return;

    const existingTail = messages.slice(userMsgIndex + 1);
    if (existingTail.length > 0) {
      setBranchesByUserMsgId((prev) => ({
        ...prev,
        [targetMsg.id]: {
          variants: [existingTail],
          activeIdx: 1,
        },
      }));
    }

    const prefix = messages.slice(0, userMsgIndex);
    setMessages(prefix);
    await rewindServerHistory(targetMsg.id, true);
    void sendMessage({ text: trimmed });
  };

  const handleRewindCheckpoint = (turnIndex: number) => {
    const anchorMsg = messages[turnIndex];
    setMessages((prev) => prev.slice(0, turnIndex + 1));
    void rewindServerHistory(anchorMsg?.id, false);
    toast.success('Rewound conversation to checkpoint');
  };

  const providerOverrideHeader = useMemo(() => {
    const override = buildProviderOverridePayload(providerSettings);
    return override ? JSON.stringify(override) : undefined;
  }, [providerSettings]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-canvas)]">
      {/* Scrollable Conversation Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="astryx-scroll-shadow min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-6 pb-8"
      >
        <div className="mx-auto w-full min-w-0 max-w-3xl">
          {messages.length === 0 ? (
            /* Serene Astryx Empty State + 6 Interactive Starter Prompt Cards */
            <div className="flex flex-col items-center py-8 sm:py-14">
              <div className="mb-4 flex size-12 items-center justify-center rounded-[var(--radius-container)] bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[var(--shadow-med)]">
                <Sparkles className="size-6" />
              </div>
              <h1 className="text-center text-2xl font-semibold tracking-tight text-[var(--fg-primary)] sm:text-3xl">
                What would you like to build?
              </h1>
              <p className="mt-2 max-w-lg text-center text-sm leading-relaxed text-[var(--fg-secondary)]">
                A serene web Agent Development Environment powered by AI SDK 7, Vercel Labs
                sandboxes, streaming <code className="font-mono text-xs">json-render</code>, and a
                self-operating <code className="font-mono text-xs">@ui-sdk/react</code> bridge.
              </p>

              <div className="mt-8 w-full">
                <SuggestionGrid
                  columns={3}
                  suggestions={STARTER_PROMPTS}
                  onSelect={(prompt) => {
                    onChatTitleHint?.(prompt);
                    void sendMessage({ text: prompt });
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((msg, msgIndex) => {
                const isUser = msg.role === 'user';
                const isLastMessage = msgIndex === messages.length - 1;
                const isMsgStreaming = !isUser && isLastMessage && isStreaming;

                // Pre-compute cumulative json-render spec for this message
                const spec = buildSpecFromParts(
                  msg.parts as Array<{
                    type: string;
                    text?: string;
                    data?: unknown;
                  }>,
                );
                let renderedSpecOnce = false;

                // Collect source-url parts for a single crisp SourcesBar
                const sourceItems: SourceItem[] = [];
                let toolCount = 0;
                for (const part of msg.parts) {
                  if (part.type === 'source-url') {
                    sourceItems.push({
                      id: part.sourceId,
                      url: part.url,
                      title: part.title,
                    });
                  }
                  if (isToolUIPart(part)) {
                    toolCount += 1;
                  }
                }

                // Branch info for assistant messages anchored to preceding user msg
                const prevUserMsg = !isUser
                  ? messages
                      .slice(0, msgIndex)
                      .reverse()
                      .find((m) => m.role === 'user')
                  : undefined;
                const branchEntry = prevUserMsg ? branchesByUserMsgId[prevUserMsg.id] : undefined;
                const showBranchSwitcher =
                  !isUser && branchEntry && branchEntry.variants.length > 1;

                // Checkpoint divider every 2 full assistant turns
                const showCheckpoint =
                  !isUser && !isLastMessage && msgIndex >= 3 && msgIndex % 4 === 3;

                return (
                  <div key={msg.id} className="min-w-0">
                    <article
                      className={cn(
                        'group flex min-w-0 flex-col',
                        isUser ? 'items-end' : 'items-start',
                      )}
                    >
                      {isUser ? (
                        /* USER TURN */
                        <div className="max-w-[85%] space-y-2">
                          {/* User file attachments */}
                          {msg.parts.some((p) => p.type === 'file') && (
                            <div className="flex flex-wrap justify-end gap-2">
                              {msg.parts.map((part, pIdx) => {
                                if (part.type !== 'file') return null;
                                const isImg = part.mediaType?.startsWith('image/');
                                return isImg ? (
                                  // biome-ignore lint/performance/noImgElement: uploaded user image attachment
                                  <img
                                    key={`${msg.id}-f-${pIdx}`}
                                    src={part.url}
                                    alt={part.filename ?? 'Attached image'}
                                    className="max-h-48 max-w-xs rounded-[var(--radius-container)] border border-[var(--border-subtle)] object-cover shadow-[var(--shadow-low)]"
                                  />
                                ) : (
                                  <a
                                    key={`${msg.id}-f-${pIdx}`}
                                    href={part.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--fg-primary)] shadow-[var(--shadow-low)]"
                                  >
                                    {part.mediaType?.includes('pdf') ? (
                                      <FileText className="size-3.5 text-[var(--accent)]" />
                                    ) : (
                                      <FileCode2 className="size-3.5 text-[var(--accent)]" />
                                    )}
                                    <span className="max-w-[180px] truncate">
                                      {part.filename ?? 'Attachment'}
                                    </span>
                                  </a>
                                );
                              })}
                            </div>
                          )}

                          {editingMessageId === msg.id ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleCommitUserEdit(msgIndex);
                              }}
                              className="w-[min(560px,82vw)] space-y-2 rounded-[var(--radius-container)] border border-[var(--accent)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-med)]"
                            >
                              <textarea
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                rows={3}
                                ref={(el) => {
                                  if (el && document.activeElement !== el) el.focus();
                                }}
                                className="w-full resize-none bg-transparent text-sm text-[var(--fg-primary)] outline-none"
                              />
                              <div className="flex justify-end gap-1.5">
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => setEditingMessageId(null)}
                                >
                                  Cancel
                                </Button>
                                <Button type="submit" variant="primary" size="xs">
                                  Save & Branch
                                </Button>
                              </div>
                            </form>
                          ) : (
                            <div className="rounded-[var(--radius-chat)] rounded-br-[var(--radius-inner)] bg-[var(--bg-surface)] px-4 py-2.5 text-sm leading-relaxed text-[var(--fg-primary)] shadow-[var(--shadow-low)] ring-1 ring-[var(--border-subtle)]">
                              <p className="whitespace-pre-wrap break-words">
                                {extractPlainTextFromMessage(msg)}
                              </p>
                            </div>
                          )}

                          {/* Subtle User Turn Actions */}
                          {editingMessageId !== msg.id && (
                            <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                type="button"
                                onClick={() => void handleCopyMessage(msg)}
                                className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                                title="Copy prompt"
                              >
                                {copiedId === msg.id ? (
                                  <Check className="size-3 text-[var(--status-success)]" />
                                ) : (
                                  <Copy className="size-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMessageId(msg.id);
                                  setEditingText(extractPlainTextFromMessage(msg));
                                }}
                                className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                                title="Edit & branch conversation"
                              >
                                <Pencil className="size-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        /* ASSISTANT TURN — Exact interleaved AI SDK 7 parts */
                        <div className="w-full min-w-0 space-y-2">
                          {/* Assistant Turn Header */}
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent)]">
                                <Bot className="size-3.5" />
                              </span>
                              <span className="shrink-0 text-xs font-semibold text-[var(--fg-primary)]">
                                Web ADE
                              </span>
                              {msg.metadata?.modelId && (
                                <span className="truncate font-mono text-[10.5px] text-[var(--fg-muted)]">
                                  {msg.metadata.modelId}
                                </span>
                              )}
                            </div>

                            {(toolCount > 0 || msg.metadata?.latencyMs || isMsgStreaming) && (
                              <TracePill
                                stepCount={Math.max(1, toolCount)}
                                toolCount={toolCount}
                                latencyMs={msg.metadata?.latencyMs}
                                totalTokens={msg.metadata?.usage?.totalTokens}
                                isStreaming={isMsgStreaming}
                                onOpenTrace={() => onOpenWorkbench('trace')}
                              />
                            )}
                          </div>

                          {/* Interleaved Parts */}
                          <div className="min-w-0 pl-8">
                            {msg.parts.map((part, partIdx) => {
                              // 1. Text
                              if (part.type === 'text') {
                                return (
                                  <MessageRenderer
                                    key={`${msg.id}-txt-${partIdx}`}
                                    content={part.text}
                                    isStreaming={isMsgStreaming && partIdx === msg.parts.length - 1}
                                    smooth={isMsgStreaming}
                                  />
                                );
                              }

                              // 2. Reasoning / Chain of Thought
                              if (part.type === 'reasoning') {
                                return (
                                  <ReasoningBlock
                                    key={`${msg.id}-rsn-${partIdx}`}
                                    content={part.text}
                                    isStreaming={part.state === 'streaming'}
                                    durationMs={msg.metadata?.reasoningDurationMs}
                                  />
                                );
                              }

                              // 3. Multimodal File / Generated Image Part
                              if (part.type === 'file') {
                                const isImg = part.mediaType?.startsWith('image/');
                                return (
                                  <div key={`${msg.id}-file-${partIdx}`} className="my-2.5">
                                    {isImg ? (
                                      <figure className="overflow-hidden rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-low)]">
                                        {/* biome-ignore lint/performance/noImgElement: model-emitted image output */}
                                        <img
                                          src={part.url}
                                          alt={part.filename ?? 'Generated image'}
                                          className="max-h-96 w-full object-contain bg-[var(--bg-surface-subtle)]"
                                        />
                                      </figure>
                                    ) : (
                                      <a
                                        href={part.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-2 rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-xs text-[var(--fg-primary)]"
                                      >
                                        <FileText className="size-4 text-[var(--accent)]" />
                                        <span>{part.filename ?? 'Generated file'}</span>
                                      </a>
                                    )}
                                  </div>
                                );
                              }

                              // 4. Streaming Generative UI (`data-spec` / SPEC_DATA_PART_TYPE)
                              if (part.type === SPEC_DATA_PART_TYPE) {
                                if (renderedSpecOnce || !spec) return null;
                                renderedSpecOnce = true;
                                return (
                                  <GenUIRenderer
                                    key={`${msg.id}-genui-${partIdx}`}
                                    spec={spec}
                                    loading={isMsgStreaming}
                                    onAction={onGenUiAction}
                                    onPromoteToCanvas={onPromoteGenUiSpec}
                                  />
                                );
                              }

                              // 5. Tool Invocations (Sentinel approval, AskUser, Image Gen, UI Bridge, Coding/Browser tools)
                              if (isToolUIPart(part)) {
                                const toolName =
                                  part.type === 'dynamic-tool'
                                    ? part.toolName
                                    : part.type.replace(/^tool-/, '');

                                // Structured Clarifying Questionnaire (`ask_user`)
                                if (toolName === 'ask_user') {
                                  const askInput = (part.input ?? {}) as {
                                    title?: string;
                                    questions?: ClarifyingQuestion[];
                                  };
                                  const questions = Array.isArray(askInput.questions)
                                    ? askInput.questions
                                    : [];
                                  const submitted =
                                    part.state === 'output-available' &&
                                    part.output &&
                                    typeof part.output === 'object' &&
                                    'answers' in part.output
                                      ? ((
                                          part.output as {
                                            answers?: Record<string, string[]>;
                                          }
                                        ).answers ?? undefined)
                                      : undefined;

                                  if (questions.length > 0) {
                                    return (
                                      <AskUserCard
                                        key={part.toolCallId}
                                        toolCallId={part.toolCallId}
                                        title={askInput.title}
                                        questions={questions}
                                        submittedAnswers={submitted}
                                        onSubmit={(answers, summary) => {
                                          void addToolOutput({
                                            tool: 'ask_user',
                                            toolCallId: part.toolCallId,
                                            output: { answers, summary },
                                          });
                                        }}
                                      />
                                    );
                                  }
                                }

                                // Sentinel Human-in-the-Loop Approval Gate
                                if (part.state === 'approval-requested' && part.approval?.id) {
                                  const approvalId = part.approval.id;
                                  const riskLevel =
                                    toolName === 'bash'
                                      ? 'high'
                                      : toolName === 'ui_act'
                                        ? 'medium'
                                        : 'medium';
                                  return (
                                    <ConfirmationCard
                                      key={part.toolCallId}
                                      approvalId={approvalId}
                                      toolName={toolName}
                                      riskLevel={riskLevel}
                                      input={part.input}
                                      status="pending"
                                      onApprove={(id, opts) => {
                                        if (opts?.alwaysAllow) {
                                          sessionApprovedToolsRef.current.add(toolName);
                                        }
                                        if (toolName === 'ui_act') {
                                          void executeUiActToolCall(part.toolCallId, part.input);
                                          return;
                                        }
                                        void addToolApprovalResponse({
                                          id,
                                          approved: true,
                                          reason: opts?.reason,
                                        });
                                      }}
                                      onDeny={(id, reason) => {
                                        void addToolApprovalResponse({
                                          id,
                                          approved: false,
                                          reason: reason ?? 'Denied by user via Sentinel gate.',
                                        });
                                      }}
                                    />
                                  );
                                }

                                // Generated image preview card if `generate_image` succeeded
                                const imageOutput =
                                  toolName === 'generate_image' &&
                                  part.state === 'output-available' &&
                                  part.output &&
                                  typeof part.output === 'object' &&
                                  'url' in part.output &&
                                  typeof (part.output as { url?: unknown }).url === 'string'
                                    ? (part.output as {
                                        url: string;
                                        prompt?: string;
                                        modelId?: string;
                                      })
                                    : null;

                                return (
                                  <div key={part.toolCallId}>
                                    <ToolCard
                                      toolName={toolName}
                                      toolCallId={part.toolCallId}
                                      state={part.state as ToolCardState}
                                      input={part.input}
                                      output={
                                        part.state === 'output-available' ? part.output : undefined
                                      }
                                      errorText={
                                        part.state === 'output-error' ? part.errorText : undefined
                                      }
                                      onOpenWorkbench={onOpenWorkbench}
                                    />

                                    {imageOutput && (
                                      <figure className="my-2.5 overflow-hidden rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-med)]">
                                        {/* biome-ignore lint/performance/noImgElement: AI-generated image output */}
                                        <img
                                          src={imageOutput.url}
                                          alt={imageOutput.prompt ?? 'Generated image'}
                                          className="max-h-[420px] w-full object-contain bg-[var(--bg-surface-subtle)]"
                                        />
                                        <figcaption className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3.5 py-2 text-xs text-[var(--fg-muted)]">
                                          <span className="truncate">
                                            {imageOutput.prompt ?? 'Generated image'}
                                          </span>
                                          <a
                                            href={imageOutput.url}
                                            download="web-ade-image.png"
                                            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-inner)] px-2 py-1 text-[11px] font-medium text-[var(--fg-primary)] hover:bg-[var(--overlay-hover)]"
                                          >
                                            <Download className="size-3" />
                                            Save
                                          </a>
                                        </figcaption>
                                      </figure>
                                    )}
                                  </div>
                                );
                              }

                              return null;
                            })}

                            {/* Cited Sources Bar */}
                            {sourceItems.length > 0 && <SourcesBar sources={sourceItems} />}

                            {/* Assistant Turn Action Footer */}
                            {!isMsgStreaming && (
                              <div className="mt-2.5 flex flex-wrap items-center gap-1 text-[var(--fg-muted)]">
                                <button
                                  type="button"
                                  onClick={() => void handleCopyMessage(msg)}
                                  className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[var(--radius-inner)] px-2 text-[11px] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                                  title="Copy response"
                                >
                                  {copiedId === msg.id ? (
                                    <Check className="size-3.5 text-[var(--status-success)]" />
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                  <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => void handleVote(msg.id, true)}
                                  aria-label="Upvote response"
                                  className={cn(
                                    'inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-inner)] hover:bg-[var(--overlay-hover)]',
                                    votes[msg.id] === true && 'text-[var(--status-success)]',
                                  )}
                                >
                                  <ThumbsUp className="size-3.5" />
                                </button>

                                <button
                                  type="button"
                                  onClick={() => void handleVote(msg.id, false)}
                                  aria-label="Downvote response"
                                  className={cn(
                                    'inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-inner)] hover:bg-[var(--overlay-hover)]',
                                    votes[msg.id] === false && 'text-[var(--status-danger)]',
                                  )}
                                >
                                  <ThumbsDown className="size-3.5" />
                                </button>

                                <button
                                  type="button"
                                  onClick={() => void handleRegenerateWithBranch(msgIndex)}
                                  className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[var(--radius-inner)] px-2 text-[11px] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                                  title="Regenerate branch"
                                >
                                  <RefreshCw className="size-3.5" />
                                  <span>Retry</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => void handleSpeakMessage(msg)}
                                  className={cn(
                                    'inline-flex h-7 cursor-pointer items-center gap-1 rounded-[var(--radius-inner)] px-2 text-[11px] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]',
                                    speakingId === msg.id && 'text-[var(--accent)]',
                                  )}
                                  title="Read aloud (TTS)"
                                >
                                  {speakingId === msg.id ? (
                                    <VolumeX className="size-3.5" />
                                  ) : (
                                    <Volume2 className="size-3.5" />
                                  )}
                                  <span>{speakingId === msg.id ? 'Stop' : 'Speak'}</span>
                                </button>

                                {showBranchSwitcher && prevUserMsg && (
                                  <div className="ml-1 inline-flex items-center gap-0.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1 py-0.5 font-mono text-[10.5px] text-[var(--fg-secondary)]">
                                    <button
                                      type="button"
                                      onClick={() => handleSwitchBranch(prevUserMsg.id, -1)}
                                      className="rounded-full p-0.5 hover:bg-[var(--overlay-hover)]"
                                      aria-label="Previous branch"
                                    >
                                      <ChevronLeft className="size-3" />
                                    </button>
                                    <span>
                                      {branchEntry.activeIdx + 1}/{branchEntry.variants.length}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleSwitchBranch(prevUserMsg.id, 1)}
                                      className="rounded-full p-0.5 hover:bg-[var(--overlay-hover)]"
                                      aria-label="Next branch"
                                    >
                                      <ChevronRight className="size-3" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </article>

                    {showCheckpoint && (
                      <CheckpointDivider
                        id={`cp-${msgIndex}`}
                        label={`Checkpoint ${Math.floor((msgIndex + 1) / 2)}`}
                        messageCount={msgIndex + 1}
                        onRestore={() => handleRewindCheckpoint(msgIndex)}
                      />
                    )}
                  </div>
                );
              })}

              {/* Error Banner */}
              {error && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-container)] border border-[var(--status-danger)]/35 bg-[var(--status-danger-soft)] px-4 py-3 text-xs text-[var(--status-danger)]"
                >
                  <span className="min-w-0 flex-1 break-words">
                    {error.message || 'An error occurred while streaming.'}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => onOpenSettings('providers')}
                    >
                      Check Providers
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        clearError();
                        void regenerate();
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              )}

              <div ref={bottomSentinelRef} className="h-1" />
            </div>
          )}
        </div>
      </div>

      {/* Floating "Jump to bottom" Pill when user scrolled up */}
      {!isNearBottom && messages.length > 0 && (
        <div className="pointer-events-none absolute right-0 bottom-36 left-0 z-20 flex justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="pointer-events-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-popover)]/95 px-3 py-1.5 text-xs font-medium text-[var(--fg-primary)] shadow-[var(--shadow-med)] backdrop-blur-md hover:bg-[var(--overlay-hover)]"
          >
            <ArrowDown className="size-3.5" />
            <span>Jump to bottom</span>
          </button>
        </div>
      )}

      {/* Multimodal Floating Pill Composer */}
      <Composer
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleComposerSubmit}
        onStop={() => void stop()}
        onSlashCommand={handleSlashCommand}
        isStreaming={isStreaming}
        models={models}
        modelId={modelId}
        onChangeModel={onChangeModel}
        harnessMode={harnessMode}
        onChangeHarness={onChangeHarness}
        billingInfo={billingInfo}
        onOpenSettings={() => onOpenSettings('providers')}
        onOpenRealtimeVoice={onOpenRealtimeVoice}
        usage={usage}
        workspaceFiles={workspaceFiles}
        queuedPrompts={queuedPrompts}
        onRemoveQueuedPrompt={(id) =>
          setQueuedPrompts((prev) => prev.filter((item) => item.id !== id))
        }
        onMoveQueuedPromptUp={(id) =>
          setQueuedPrompts((prev) => {
            const idx = prev.findIndex((i) => i.id === id);
            if (idx <= 0) return prev;
            const copy = [...prev];
            const [item] = copy.splice(idx, 1);
            if (item) copy.splice(idx - 1, 0, item);
            return copy;
          })
        }
        onClearQueuedPrompts={() => setQueuedPrompts([])}
        providerOverrideHeader={providerOverrideHeader}
      />
    </div>
  );
}
