'use client';

import {
  type TriggerDefinition,
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuGroup,
  TriggerMenuGroupLabel,
  TriggerMenuInput,
  TriggerMenuItem,
  TriggerMenuList,
} from '@ui-sdk/react/trigger-menu';
import type { FileUIPart } from 'ai';
import {
  ArrowUp,
  AudioLines,
  Bot,
  Check,
  ChevronDown,
  FileCode2,
  FileText,
  ImageIcon,
  Layers,
  Loader2,
  Lock,
  Mic,
  MicOff,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { BillingBadge } from '@/components/ai-elements/billing-badge';
import { ContextMeter } from '@/components/ai-elements/context-meter';
import { PromptQueue, type QueuedPromptItem } from '@/components/ai-elements/prompt-queue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getModelDefinition, getModelsByProvider, isSponsoredModelId } from '@/lib/ai/models';
import type {
  AttachmentItem,
  BillingSourceInfo,
  HarnessMode,
  ModelDefinition,
  TokenUsageSummary,
  WorkspaceFileEntry,
} from '@/lib/types';
import { cn, formatBytes } from '@/lib/utils';

export interface ComposerSubmitPayload {
  text: string;
  files: FileUIPart[];
  attachments: AttachmentItem[];
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (payload: ComposerSubmitPayload) => void;
  onStop?: () => void;
  onSlashCommand?: (command: string) => boolean | undefined;
  isStreaming: boolean;
  models: ModelDefinition[];
  modelId: string;
  onChangeModel: (modelId: string) => void;
  harnessMode: HarnessMode;
  onChangeHarness: (harness: HarnessMode) => void;
  billingInfo: BillingSourceInfo;
  onOpenSettings: () => void;
  onOpenRealtimeVoice: () => void;
  usage?: Partial<TokenUsageSummary> | null;
  workspaceFiles?: WorkspaceFileEntry[];
  queuedPrompts?: QueuedPromptItem[];
  onRemoveQueuedPrompt?: (id: string) => void;
  onMoveQueuedPromptUp?: (id: string) => void;
  onClearQueuedPrompts?: () => void;
  providerOverrideHeader?: string;
  placeholder?: string;
  className?: string;
}

interface SlashCommandMeta {
  value: string;
  label: string;
  description: string;
  promptPrefix?: string;
}

const SLASH_COMMANDS: SlashCommandMeta[] = [
  {
    value: 'preview',
    label: 'preview',
    description: 'Build & open an interactive live HTML app preview',
    promptPrefix: 'Build an interactive single-file HTML preview app: ',
  },
  {
    value: 'browser',
    label: 'browser',
    description: 'Browse, inspect, or interact with a live website',
    promptPrefix: 'Open the embedded browser and inspect ',
  },
  {
    value: 'terminal',
    label: 'terminal',
    description: 'Run shell commands or inspect workspace files in @wterm',
    promptPrefix: 'Run a shell task in the workspace: ',
  },
  {
    value: 'genui',
    label: 'genui',
    description: 'Stream an interactive json-render dashboard or widget',
    promptPrefix: 'Stream an interactive json-render UI widget for ',
  },
  {
    value: 'fx',
    label: 'fx',
    description: 'Switch active harness to libfx durable coding mode',
  },
  {
    value: 'workflow',
    label: 'workflow',
    description: 'Switch active harness to Workflow 5 durable agent',
  },
  {
    value: 'image',
    label: 'image',
    description: 'Generate an image with multimodal vision synthesis',
    promptPrefix: 'Generate an image of ',
  },
  {
    value: 'ui',
    label: 'ui',
    description: 'Operate the ADE UI via @ui-sdk/react/agent bridge',
    promptPrefix: 'Use the UI Agent Bridge (ui_snapshot / ui_act) to ',
  },
  {
    value: 'clear',
    label: 'clear',
    description: 'Start a fresh conversation',
  },
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

function flattenFilePaths(entries: WorkspaceFileEntry[]): string[] {
  const out: string[] = [];
  const walk = (list: WorkspaceFileEntry[]) => {
    for (const item of list) {
      if (item.type === 'directory' && item.children) {
        walk(item.children);
      } else if (item.type === 'file') {
        out.push(item.path.replace(/^\/+/, ''));
      }
    }
  };
  walk(entries);
  return out;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  onSlashCommand,
  isStreaming,
  models,
  modelId,
  onChangeModel,
  harnessMode,
  onChangeHarness,
  billingInfo,
  onOpenSettings,
  onOpenRealtimeVoice,
  usage,
  workspaceFiles = [],
  queuedPrompts = [],
  onRemoveQueuedPrompt,
  onMoveQueuedPromptUp,
  onClearQueuedPrompts,
  providerOverrideHeader,
  placeholder = 'Ask anything, build an app, run shell commands, or type / for actions and @ for files…',
  className,
}: ComposerProps) {
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [activeTrigger, setActiveTrigger] = useState<string | null>(null);
  const [triggerQuery, setTriggerQuery] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const triggerMenuOpenRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const speechRecognitionRef = useRef<{
    lang: string;
    interimResults: boolean;
    onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
    onerror: (() => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  } | null>(null);

  const activeModel = useMemo(
    () => models.find((m) => m.id === modelId) ?? getModelDefinition(modelId) ?? models[0],
    [models, modelId],
  );

  const groupedModels = useMemo(() => {
    if (models.length === 0) return getModelsByProvider();
    const groups: Record<string, ModelDefinition[]> = {};
    for (const m of models) {
      const list = groups[m.provider] ?? [];
      list.push(m);
      groups[m.provider] = list;
    }
    return groups;
  }, [models]);

  const filePaths = useMemo(() => flattenFilePaths(workspaceFiles), [workspaceFiles]);

  // Auto-grow textarea cleanly
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = value.length === 0 ? '48px' : `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesArr = Array.from(fileList);
    if (filesArr.length === 0) return;

    setUploading(true);
    try {
      const uploaded: AttachmentItem[] = [];
      for (const file of filesArr) {
        if (file.size > 4.5 * 1024 * 1024) {
          toast.error(`${file.name} exceeds the 4.5 MB upload limit.`);
          continue;
        }
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(err.error ?? `Failed to upload ${file.name}`);
          continue;
        }
        const data = (await res.json()) as AttachmentItem;
        uploaded.push({
          ...data,
          previewUrl: file.type.startsWith('image/') ? data.url : data.previewUrl,
        });
      }
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded]);
      }
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    if (e.dataTransfer.files?.length) {
      void uploadFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  const startWebSpeechDictation = useCallback((): boolean => {
    if (typeof window === 'undefined') return false;
    const win = window as unknown as {
      SpeechRecognition?: new () => NonNullable<typeof speechRecognitionRef.current>;
      webkitSpeechRecognition?: new () => NonNullable<typeof speechRecognitionRef.current>;
    };
    const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SR) return false;

    try {
      speechRecognitionRef.current?.stop();
    } catch {
      // ignore
    }

    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript?.trim();
      if (text) {
        const latest = valueRef.current;
        onChange(latest ? `${latest.trimEnd()} ${text}` : text);
        textareaRef.current?.focus();
      }
    };
    rec.onerror = () => {
      speechRecognitionRef.current = null;
      setRecording(false);
    };
    rec.onend = () => {
      speechRecognitionRef.current = null;
      setRecording(false);
    };
    speechRecognitionRef.current = rec;
    setRecording(true);
    rec.start();
    return true;
  }, [onChange]);

  // Voice Dictation (MediaRecorder -> /api/voice/transcribe with Web Speech API fallback)
  const toggleVoiceDictation = useCallback(async () => {
    if (recording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          // ignore
        }
        speechRecognitionRef.current = null;
      }
      setRecording(false);
      return;
    }

    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof MediaRecorder !== 'undefined'
    ) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
        };
        recorder.onstop = async () => {
          for (const track of stream.getTracks()) track.stop();
          mediaRecorderRef.current = null;
          const blob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          if (blob.size === 0) return;

          setTranscribing(true);
          try {
            const form = new FormData();
            form.append('audio', blob, 'dictation.webm');
            const headers: HeadersInit = {};
            if (providerOverrideHeader) {
              headers['x-ade-provider-override'] = providerOverrideHeader;
            }
            const res = await fetch('/api/voice/transcribe', {
              method: 'POST',
              headers,
              body: form,
            });
            if (!res.ok) {
              throw new Error(`Server transcription unavailable (${res.status})`);
            }
            const data = (await res.json()) as { text?: string };
            if (data.text?.trim()) {
              const latest = valueRef.current;
              onChange(latest ? `${latest.trimEnd()} ${data.text.trim()}` : data.text.trim());
              textareaRef.current?.focus();
            }
          } catch {
            if (startWebSpeechDictation()) {
              toast.info(
                'Server transcription unavailable — switched to live browser dictation. Speak now…',
              );
            } else {
              toast.info(
                'Server transcription unavailable — try Live Realtime Voice or browser dictation.',
              );
            }
          } finally {
            setTranscribing(false);
          }
        };

        mediaRecorderRef.current = recorder;
        recorder.start();
        setRecording(true);
        return;
      } catch {
        // Fall through to Web Speech API
      }
    }

    if (!startWebSpeechDictation()) {
      toast.error('Microphone access or Speech Recognition is unavailable.');
    }
  }, [recording, onChange, providerOverrideHeader, startWebSpeechDictation]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;

    // Handle standalone slash command invocations like "/clear", "/fx", "/workflow"
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && attachments.length === 0) {
      const cmdName = trimmed.slice(1).toLowerCase();
      const handled = onSlashCommand?.(cmdName);
      if (handled) {
        onChange('');
        return;
      }
    }

    const fileParts: FileUIPart[] = attachments.map((att) => ({
      type: 'file',
      url: att.url,
      mediaType: att.mediaType,
      filename: att.name,
    }));

    onSubmit({
      text: trimmed,
      files: fileParts,
      attachments: [...attachments],
    });
    onChange('');
    setAttachments([]);
  }, [value, attachments, onSubmit, onChange, onSlashCommand]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !triggerMenuOpenRef.current
    ) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // @ui-sdk/react/trigger-menu definitions for `/` slash commands and `@` workspace files
  const triggers = useMemo<TriggerDefinition<string>[]>(
    () => [
      {
        char: '/',
        boundary: 'start',
        items: SLASH_COMMANDS.map((c) => ({
          value: `slash:${c.value}`,
          label: c.label,
        })),
      },
      {
        char: '@',
        boundary: 'word',
        items: (filePaths.length > 0
          ? filePaths
          : ['README.md', 'index.html', 'src/hello.ts', 'notes.md']
        ).map((path) => ({
          value: `file:${path}`,
          label: path,
        })),
      },
    ],
    [filePaths],
  );

  const filteredSlashCommands = useMemo(() => {
    const q = triggerQuery.trim().toLowerCase();
    return q
      ? SLASH_COMMANDS.filter(
          (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
        )
      : SLASH_COMMANDS;
  }, [triggerQuery]);

  const filteredFilePaths = useMemo(() => {
    const paths =
      filePaths.length > 0 ? filePaths : ['README.md', 'index.html', 'src/hello.ts', 'notes.md'];
    const q = triggerQuery.trim().toLowerCase();
    return q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths;
  }, [filePaths, triggerQuery]);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !uploading;

  return (
    <div className={cn('mx-auto w-full max-w-3xl px-3 pb-3 pt-1', className)}>
      {/* Prompt Queue when user submits while streaming */}
      {queuedPrompts.length > 0 && onRemoveQueuedPrompt && (
        <PromptQueue
          items={queuedPrompts}
          onRemove={onRemoveQueuedPrompt}
          onMoveUp={onMoveQueuedPromptUp}
          onClear={onClearQueuedPrompts}
        />
      )}

      {/* Astryx Floating Pill Composer */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-[var(--radius-chat)] border bg-[var(--bg-surface)]',
          'shadow-[var(--shadow-med)] transition-[border-color,box-shadow] duration-[var(--duration-fast)]',
          draggingOver
            ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30'
            : 'border-[var(--border-subtle)] focus-within:border-[var(--accent)]/55 focus-within:shadow-[var(--shadow-high)]',
        )}
      >
        {/* Drag overlay hint */}
        {draggingOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--radius-chat)] bg-[var(--accent-soft)] backdrop-blur-[1px]">
            <span className="rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--accent-foreground)]">
              Drop images, PDFs, code, or audio to attach
            </span>
          </div>
        )}

        {/* Attachment Preview Chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-1">
            {attachments.map((att) => {
              const isImg = att.mediaType.startsWith('image/');
              return (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-2 rounded-[var(--radius-element)] border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] py-1 pr-2 pl-1.5 text-xs"
                >
                  {isImg && att.previewUrl ? (
                    // biome-ignore lint/performance/noImgElement: dynamic user upload preview blob/data URL
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="size-8 rounded-[var(--radius-inner)] object-cover"
                    />
                  ) : (
                    <div className="flex size-8 items-center justify-center rounded-[var(--radius-inner)] bg-[var(--bg-surface)] text-[var(--accent)]">
                      {isImg ? (
                        <ImageIcon className="size-4" />
                      ) : att.mediaType.includes('pdf') ? (
                        <FileText className="size-4" />
                      ) : (
                        <FileCode2 className="size-4" />
                      )}
                    </div>
                  )}
                  <div className="min-w-0 max-w-[140px]">
                    <div className="truncate font-medium text-[var(--fg-primary)]">{att.name}</div>
                    <div className="font-mono text-[10px] text-[var(--fg-muted)]">
                      {formatBytes(att.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    className="rounded-full p-0.5 text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
                    aria-label={`Remove ${att.name}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Textarea wrapped in @ui-sdk/react/trigger-menu for `/` and `@` */}
        <TriggerMenu
          triggers={triggers}
          onOpenChange={(open, details) => {
            if (textareaRef.current && textareaRef.current.value !== value) {
              onChange(textareaRef.current.value);
            }
            triggerMenuOpenRef.current = open;
            setActiveTrigger(open ? details.trigger : null);
            if (!open) setTriggerQuery('');
          }}
          onQueryChange={(q) => {
            if (textareaRef.current && textareaRef.current.value !== value) {
              onChange(textareaRef.current.value);
            }
            setTriggerQuery(q);
          }}
          onSelect={(selectedValue, details) => {
            details.preventDefault();
            if (selectedValue.startsWith('slash:')) {
              const cmdId = selectedValue.slice('slash:'.length);
              const cmd = SLASH_COMMANDS.find((c) => c.value === cmdId);
              const handled = onSlashCommand?.(cmdId);
              if (handled) {
                onChange('');
              } else if (cmd?.promptPrefix) {
                onChange(cmd.promptPrefix);
              } else {
                details.insert(`/${cmdId} `);
                if (textareaRef.current) {
                  onChange(textareaRef.current.value);
                }
              }
            } else if (selectedValue.startsWith('file:')) {
              const filePath = selectedValue.slice('file:'.length);
              const liveText = textareaRef.current?.value ?? value;
              const before = liveText.slice(0, details.match.start);
              const after = liveText.slice(details.match.end);
              onChange(`${before}@${filePath} ${after}`);
            }
            textareaRef.current?.focus();
          }}
        >
          <TriggerMenuInput
            ref={textareaRef}
            value={value}
            onInputCapture={(e) => {
              const next = e.currentTarget.value;
              if (next !== value) onChange(next);
            }}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            placeholder={placeholder}
            aria-label="Message Web ADE"
            className="block max-h-[220px] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm leading-relaxed text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none"
          />

          <TriggerMenuContent
            side="top"
            align="start"
            sideOffset={8}
            className="z-50 w-80 max-w-[90vw] overflow-hidden rounded-[var(--radius-container)] border border-[var(--border-subtle)] bg-[var(--bg-popover)] p-1.5 shadow-[var(--shadow-high)]"
          >
            <TriggerMenuList className="max-h-60 overflow-y-auto">
              {activeTrigger === '/' && (
                <TriggerMenuGroup>
                  <TriggerMenuGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
                    Slash Commands
                  </TriggerMenuGroupLabel>
                  {filteredSlashCommands.map((cmd) => (
                    <TriggerMenuItem
                      key={cmd.value}
                      value={`slash:${cmd.value}`}
                      label={cmd.label}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-inner)] px-2.5 py-1.5 text-xs data-[highlighted]:bg-[var(--overlay-hover)]"
                    >
                      <span className="font-mono font-semibold text-[var(--accent)]">
                        /{cmd.label}
                      </span>
                      <span className="truncate text-[11px] text-[var(--fg-muted)]">
                        {cmd.description}
                      </span>
                    </TriggerMenuItem>
                  ))}
                </TriggerMenuGroup>
              )}

              {activeTrigger === '@' && (
                <TriggerMenuGroup>
                  <TriggerMenuGroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
                    Workspace Files
                  </TriggerMenuGroupLabel>
                  {filteredFilePaths.map((path) => (
                    <TriggerMenuItem
                      key={path}
                      value={`file:${path}`}
                      label={path}
                      className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-inner)] px-2.5 py-1.5 text-xs data-[highlighted]:bg-[var(--overlay-hover)]"
                    >
                      <FileCode2 className="size-3.5 shrink-0 text-[var(--fg-muted)]" />
                      <span className="truncate font-mono text-[var(--fg-primary)]">{path}</span>
                    </TriggerMenuItem>
                  ))}
                </TriggerMenuGroup>
              )}
            </TriggerMenuList>
            <TriggerMenuEmpty className="px-3 py-2 text-xs text-[var(--fg-muted)]">
              No matching commands or files.
            </TriggerMenuEmpty>
          </TriggerMenuContent>
        </TriggerMenu>

        {/* Bottom Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1">
          {/* Left Controls: Attach + Model Selector + Harness Switcher */}
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*,audio/*,.ts,.tsx,.js,.jsx,.json,.md,.py,.html,.css"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void uploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Attach files"
              title="Attach images, PDFs, code, or audio"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-[var(--fg-secondary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)] disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Paperclip className="size-4" />
              )}
            </button>

            {/* Grouped Model Selector */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Select model: ${activeModel?.name ?? modelId}`}
                className="inline-flex h-7 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] px-2.5 text-xs font-medium text-[var(--fg-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--overlay-hover)]"
              >
                <Bot className="size-3.5 shrink-0 text-[var(--accent)]" />
                <span className="truncate">{activeModel?.name ?? modelId}</span>
                <ChevronDown className="size-3 shrink-0 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="max-h-80 w-76 overflow-y-auto"
              >
                {!billingInfo.isUserBilled && billingInfo.source !== 'unconfigured' && (
                  <div className="mb-1 flex items-center justify-between gap-2 rounded-[var(--radius-inner)] bg-[var(--bg-surface-subtle)] px-2.5 py-1.5 text-[10px] text-[var(--fg-muted)]">
                    <span>Sponsored: GPT-6 Luna &amp; Haiku 5.5 only</span>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="shrink-0 cursor-pointer font-medium text-[var(--accent)] hover:underline"
                    >
                      Add key →
                    </button>
                  </div>
                )}
                {Object.entries(groupedModels).map(([provider, list], idx) => (
                  <div key={provider}>
                    {idx > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>{PROVIDER_LABELS[provider] ?? provider}</DropdownMenuLabel>
                    {list.map((m) => {
                      const isSponsoredTier =
                        !billingInfo.isUserBilled && billingInfo.source !== 'unconfigured';
                      const sponsoredEligible = m.sponsoredEligible ?? isSponsoredModelId(m.id);
                      const isLocked = isSponsoredTier && !sponsoredEligible;

                      return (
                        <DropdownMenuItem
                          key={m.id}
                          onClick={() => {
                            if (isLocked) {
                              toast.info(
                                `${m.name} requires your own OpenAI or AI Gateway key. Add one in Settings to unlock.`,
                              );
                              onOpenSettings();
                              return;
                            }
                            onChangeModel(m.id);
                          }}
                          className={cn(
                            'flex items-start justify-between gap-2 py-1.5',
                            isLocked && 'opacity-65',
                          )}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium text-[var(--fg-primary)]">
                                {m.name}
                              </span>
                              <span className="rounded bg-[var(--bg-surface-subtle)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--fg-muted)]">
                                {m.tier}
                              </span>
                              {isSponsoredTier && sponsoredEligible && (
                                <span className="rounded bg-[var(--accent)]/12 px-1 py-0.5 font-mono text-[9px] font-medium uppercase text-[var(--accent)]">
                                  Sponsored
                                </span>
                              )}
                              {isLocked && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-[var(--bg-surface-subtle)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--fg-muted)]">
                                  <Lock className="size-2.5" />
                                  BYOK
                                </span>
                              )}
                            </div>
                            <div className="truncate text-[10px] text-[var(--fg-muted)]">
                              {m.description}
                            </div>
                          </div>
                          {modelId === m.id && !isLocked && (
                            <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" />
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Compact Harness Switcher */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Agent harness: ${harnessMode}`}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[var(--fg-muted)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]"
              >
                <Layers className="size-3" />
                <span>
                  {harnessMode === 'fx'
                    ? 'fx'
                    : harnessMode === 'workflow'
                      ? 'Workflow 5'
                      : 'AI SDK 7'}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel>Execution Harness</DropdownMenuLabel>
                {(
                  [
                    ['ai-sdk', 'AI SDK 7 (Default)'],
                    ['fx', 'fx (libfx Durable)'],
                    ['workflow', 'Workflow 5 (Resumable)'],
                  ] as const
                ).map(([h, label]) => (
                  <DropdownMenuItem key={h} onClick={() => onChangeHarness(h)}>
                    <span className="flex-1">{label}</span>
                    {harnessMode === h && <Check className="size-3.5 text-[var(--accent)]" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Right Controls: Context Meter + Billing + Mic + Realtime Orb + Send/Stop */}
          <div className="flex items-center gap-1.5">
            <ContextMeter
              usage={usage}
              contextWindow={activeModel?.contextWindow}
              modelName={activeModel?.name}
            />

            <div className="hidden md:block">
              <BillingBadge
                source={billingInfo.source}
                label={billingInfo.label}
                creditsRemaining={billingInfo.creditsRemaining}
                compact
                onClick={onOpenSettings}
              />
            </div>

            {/* Dictation Mic */}
            <button
              type="button"
              onClick={() => void toggleVoiceDictation()}
              disabled={transcribing}
              aria-label={recording ? 'Stop dictation' : 'Voice dictation'}
              title={recording ? 'Stop recording & transcribe' : 'Dictate prompt (STT)'}
              className={cn(
                'inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors',
                recording
                  ? 'bg-[var(--status-danger-soft)] text-[var(--status-danger)] animate-pulse'
                  : 'text-[var(--fg-secondary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--fg-primary)]',
              )}
            >
              {transcribing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : recording ? (
                <MicOff className="size-4" />
              ) : (
                <Mic className="size-4" />
              )}
            </button>

            {/* Live Realtime Voice Orb Trigger */}
            <button
              type="button"
              onClick={onOpenRealtimeVoice}
              aria-label="Open Live Realtime Voice"
              title="Live Realtime Voice conversation"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-[var(--fg-secondary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--accent)]"
            >
              <AudioLines className="size-4" />
            </button>

            {/* Stop / Send / Queue Button */}
            {isStreaming && !canSend ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generation"
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[var(--fg-primary)] text-[var(--bg-canvas)] shadow-[var(--shadow-low)] hover:opacity-90"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSend}
                aria-label={isStreaming ? 'Queue message' : 'Send message'}
                title={
                  isStreaming
                    ? 'Add to prompt queue (runs after current turn)'
                    : 'Send message (Enter)'
                }
                className={cn(
                  'inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-opacity',
                  canSend
                    ? 'bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[var(--shadow-low)] hover:opacity-92'
                    : 'bg-[var(--bg-surface-subtle)] text-[var(--fg-muted)] opacity-50 cursor-not-allowed',
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
