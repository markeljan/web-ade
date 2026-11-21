'use client';

import { gateway } from '@ai-sdk/gateway';
import { openai } from '@ai-sdk/openai';
import { experimental_useRealtime } from '@ai-sdk/react';
import {
  AudioLines,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ClientProviderSettings } from '@/components/ade/settings-dialog';
import { REALTIME_MODEL_ID } from '@/lib/ai/models';
import { cn } from '@/lib/utils';

export interface VoiceModalProps {
  open: boolean;
  onClose: () => void;
  onSendTranscript: (transcript: string) => void;
  modelId?: string;
  providerSettings?: ClientProviderSettings;
}

function buildVoiceProviderOverride(
  settings?: ClientProviderSettings,
): Record<string, string> | undefined {
  if (!settings) return undefined;
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
  return Object.keys(out).length > 0 ? out : undefined;
}

interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface BrowserSpeechRecognitionResultEvent {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: BrowserSpeechRecognitionResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface ActiveRealtimeConnection {
  key: number;
  transport: 'gateway' | 'openai';
  modelId: string;
  websocket: string;
  protocols?: string[];
}

function createClientRealtimeModel(transport: 'gateway' | 'openai', resolvedModelId: string) {
  if (transport === 'openai') {
    const cleanModel = resolvedModelId.replace(/^openai\//i, '') || 'gpt-realtime';
    return openai.experimental_realtime(cleanModel);
  }
  return gateway.experimental_realtime(resolvedModelId || REALTIME_MODEL_ID);
}

const DEFAULT_GATEWAY_REALTIME_MODEL = gateway.experimental_realtime(REALTIME_MODEL_ID);

const REALTIME_SESSION_CONFIG = {
  instructions:
    'You are Web ADE, a calm, concise voice coding and engineering partner. Keep answers brief, structured, and helpful.',
};

export function VoiceModal({
  open,
  onClose,
  onSendTranscript,
  modelId,
  providerSettings,
}: VoiceModalProps) {
  const effectiveModelId = modelId?.trim() || REALTIME_MODEL_ID;
  const providerOverride = useMemo(
    () => buildVoiceProviderOverride(providerSettings),
    [providerSettings],
  );
  const [mode, setMode] = useState<'realtime' | 'fallback'>('realtime');
  const [activeConn, setActiveConn] = useState<ActiveRealtimeConnection | null>(null);
  const [muted, setMuted] = useState(false);
  const [pushToTalk, setPushToTalk] = useState(false);
  const [pttHeld, setPttHeld] = useState(false);
  const [fallbackListening, setFallbackListening] = useState(false);
  const [fallbackSpeaking, setFallbackSpeaking] = useState(false);
  const [fallbackTranscript, setFallbackTranscript] = useState<TranscriptEntry[]>([]);
  const [interimText, setInterimText] = useState('');
  const [statusHint, setStatusHint] = useState(
    'Tap Connect to start a live bidirectional voice session.',
  );

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const pendingConnectKeyRef = useRef<number | null>(null);

  const realtimeModel = useMemo(() => {
    if (!activeConn) return DEFAULT_GATEWAY_REALTIME_MODEL;
    return createClientRealtimeModel(activeConn.transport, activeConn.modelId);
  }, [activeConn]);

  const realtimeApi = useMemo(
    () =>
      activeConn
        ? { websocket: activeConn.websocket, protocols: activeConn.protocols }
        : { token: '/api/realtime/token' },
    [activeConn],
  );

  const realtime = experimental_useRealtime({
    model: realtimeModel,
    api: realtimeApi,
    sessionConfig: REALTIME_SESSION_CONFIG,
    onError: (err) => {
      setMode('fallback');
      setStatusHint(
        `Realtime WS unavailable (${err.message || 'using local Speech + TTS fallback'}).`,
      );
    },
  });

  // Merge realtime messages with local fallback entries
  const transcriptEntries = useMemo<TranscriptEntry[]>(() => {
    if (mode === 'fallback') return fallbackTranscript;
    const fromRealtime: TranscriptEntry[] = [];
    for (const msg of realtime.messages) {
      const text = msg.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ')
        .trim();
      if (!text) continue;
      fromRealtime.push({
        id: msg.id,
        role: msg.role === 'user' ? 'user' : 'assistant',
        text,
        timestamp: Date.now(),
      });
    }
    return fromRealtime.length > 0 ? fromRealtime : fallbackTranscript;
  }, [mode, realtime.messages, fallbackTranscript]);

  useEffect(() => {
    if (transcriptEntries.length === 0 && interimText.length === 0) return;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptEntries, interimText]);

  const stopFallbackSpeech = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    recognitionRef.current = null;
    setFallbackListening(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setFallbackSpeaking(false);
  }, []);

  // Clean up only when closing an active session
  const realtimeDisconnectRef = useRef(realtime.disconnect);
  realtimeDisconnectRef.current = realtime.disconnect;
  const realtimeStatus = realtime.status;
  const wasOpenRef = useRef(open);

  useEffect(() => {
    const closedNow = wasOpenRef.current && !open;
    wasOpenRef.current = open;
    if (!closedNow) return;
    if (realtimeStatus === 'connected' || realtimeStatus === 'connecting') {
      realtimeDisconnectRef.current();
    }
    stopFallbackSpeech();
  }, [open, realtimeStatus, stopFallbackSpeech]);

  const speakAssistantReply = useCallback(
    async (text: string) => {
      setFallbackSpeaking(true);
      try {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            ...(providerOverride ? { providerOverride } : {}),
          }),
        });
        if (res.ok && res.headers.get('content-type')?.includes('audio')) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            setFallbackSpeaking(false);
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            setFallbackSpeaking(false);
          };
          await audio.play();
          return;
        }
      } catch {
        // Fall through to browser speechSynthesis
      }

      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.04;
        utter.onend = () => setFallbackSpeaking(false);
        utter.onerror = () => setFallbackSpeaking(false);
        window.speechSynthesis.speak(utter);
      } else {
        setFallbackSpeaking(false);
      }
    },
    [providerOverride],
  );

  const startFallbackListening = useCallback(() => {
    if (typeof window === 'undefined') return;
    const win = window as unknown as {
      SpeechRecognition?: new () => BrowserSpeechRecognition;
      webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
    };
    const SpeechRec = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SpeechRec) {
      toast.error(
        'Web Speech API is not supported in this browser. Configure AI Gateway or OpenAI Realtime token.',
      );
      return;
    }

    stopFallbackSpeech();
    const rec = new SpeechRec();
    rec.continuous = !pushToTalk;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (event) => {
      let interim = '';
      let finalChunk = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (!res?.[0]) continue;
        if (res.isFinal) {
          finalChunk += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      setInterimText(interim);
      if (finalChunk.trim()) {
        const cleaned = finalChunk.trim();
        setInterimText('');
        setFallbackTranscript((prev) => [
          ...prev,
          {
            id: `u-${Date.now()}`,
            role: 'user',
            text: cleaned,
            timestamp: Date.now(),
          },
        ]);
        const ack = `Captured: "${cleaned}". Send the transcript to chat when you're ready for a full workspace action.`;
        setFallbackTranscript((prev) => [
          ...prev,
          {
            id: `a-${Date.now() + 1}`,
            role: 'assistant',
            text: ack,
            timestamp: Date.now(),
          },
        ]);
        void speakAssistantReply(ack);
      }
    };
    rec.onerror = (ev) => {
      setStatusHint(`Speech capture paused (${ev.error ?? 'mic error'}).`);
      setFallbackListening(false);
    };
    rec.onend = () => {
      setFallbackListening(false);
    };
    recognitionRef.current = rec;
    rec.start();
    setFallbackListening(true);
    setStatusHint('Listening via Web Speech fallback…');
  }, [pushToTalk, speakAssistantReply, stopFallbackSpeech]);

  const realtimeConnectRef = useRef(realtime.connect);
  realtimeConnectRef.current = realtime.connect;
  const startFallbackListeningRef = useRef(startFallbackListening);
  startFallbackListeningRef.current = startFallbackListening;

  // Connect once useRealtime has initialized the matching transport/model store
  useEffect(() => {
    if (!activeConn || pendingConnectKeyRef.current !== activeConn.key) return;
    pendingConnectKeyRef.current = null;
    void realtimeConnectRef
      .current()
      .then(() => {
        setStatusHint(
          `Live Realtime audio connected (${activeConn.transport === 'openai' ? 'OpenAI Direct' : 'AI Gateway'} · ${activeConn.modelId}).`,
        );
      })
      .catch(() => {
        setMode('fallback');
        setStatusHint(
          'Realtime connection unavailable — running in local Web Speech + TTS fallback.',
        );
        startFallbackListeningRef.current();
      });
  }, [activeConn]);

  const handleConnect = async () => {
    setMode('realtime');
    setStatusHint('Requesting ephemeral realtime token…');
    try {
      const tokenRes = await fetch('/api/realtime/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: effectiveModelId,
          ...(providerOverride ? { providerOverride } : {}),
        }),
      });
      if (!tokenRes.ok) {
        setMode('fallback');
        setStatusHint(
          'Realtime token not configured — switched seamlessly to Web Speech + TTS mode.',
        );
        startFallbackListening();
        return;
      }

      const data = (await tokenRes.json()) as {
        supported?: boolean;
        transport?: 'gateway' | 'openai' | 'unsupported';
        token?: string;
        url?: string;
        modelId?: string;
        reason?: string;
      };

      if (
        !data.supported ||
        !data.token ||
        !data.url ||
        (data.transport !== 'gateway' && data.transport !== 'openai')
      ) {
        setMode('fallback');
        setStatusHint(
          data.reason ||
            'Realtime voice unavailable for this provider — switched to Web Speech + TTS mode.',
        );
        startFallbackListening();
        return;
      }

      const resolvedModelId =
        data.modelId || (data.transport === 'openai' ? 'gpt-realtime' : effectiveModelId);
      const clientModel = createClientRealtimeModel(data.transport, resolvedModelId);
      const wsConfig = clientModel.getWebSocketConfig?.({
        token: data.token,
        url: data.url,
      });

      if (!wsConfig?.url) {
        throw new Error('Realtime model failed to produce a WebSocket configuration.');
      }

      const key = Date.now();
      pendingConnectKeyRef.current = key;
      setActiveConn({
        key,
        transport: data.transport,
        modelId: resolvedModelId,
        websocket: wsConfig.url,
        protocols: wsConfig.protocols,
      });
      setStatusHint('Connecting to live realtime audio stream…');
    } catch {
      setMode('fallback');
      setStatusHint(
        'Realtime connection unavailable — running in local Web Speech + TTS fallback.',
      );
      startFallbackListening();
    }
  };

  const releasePushToTalk = () => {
    if (!pttHeld) return;
    setPttHeld(false);
    if (mode === 'fallback') {
      stopFallbackSpeech();
    } else if (realtime.status === 'connected') {
      realtime.stopAudioCapture();
      realtime.commitAudio();
      realtime.requestResponse();
    }
  };

  const handleDisconnect = () => {
    if (realtime.status === 'connected' || realtime.status === 'connecting') {
      realtime.disconnect();
    }
    stopFallbackSpeech();
    setStatusHint('Session ended.');
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (mode === 'realtime' && realtime.status === 'connected') {
      if (nextMuted) {
        realtime.stopAudioCapture();
      } else {
        void realtime.resumeAudioCapture();
      }
    } else if (mode === 'fallback') {
      if (nextMuted) {
        stopFallbackSpeech();
      } else {
        startFallbackListening();
      }
    }
  };

  const handleSendToChat = () => {
    const combined = transcriptEntries
      .filter((t) => t.role === 'user')
      .map((t) => t.text)
      .join('\n')
      .trim();
    const fallbackAll = transcriptEntries
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
      .join('\n')
      .trim();
    const payload = combined || fallbackAll;
    if (!payload) {
      toast.info('No transcript captured yet.');
      return;
    }
    onSendTranscript(payload);
    handleDisconnect();
    onClose();
  };

  if (!open) return null;

  const isConnected =
    mode === 'realtime' ? realtime.status === 'connected' : fallbackListening || fallbackSpeaking;
  const isConnecting = mode === 'realtime' && realtime.status === 'connecting';
  const isSpeaking = mode === 'realtime' ? realtime.isPlaying : fallbackSpeaking;
  const isCapturing = mode === 'realtime' ? realtime.isCapturing && !muted : fallbackListening;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live Realtime Voice"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-page,32px)] border border-border bg-popover/98 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <AudioLines className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-sm font-semibold text-foreground">Live Realtime Voice</span>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {mode === 'realtime' ? 'AI SDK 7 Realtime' : 'Speech Fallback'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close voice modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Animated Astryx Audio Orb */}
        <div className="flex flex-col items-center justify-center px-6 py-7">
          <div className="relative flex h-36 w-36 items-center justify-center">
            {/* Outer ambient rings */}
            <div
              className={cn(
                'absolute inset-0 rounded-full transition-all duration-500',
                isSpeaking
                  ? 'scale-115 bg-[var(--accent)]/18 animate-pulse'
                  : isCapturing
                    ? 'scale-108 bg-emerald-500/18 animate-pulse'
                    : isConnecting
                      ? 'scale-105 bg-amber-500/15 animate-ping'
                      : 'scale-95 bg-muted/50',
              )}
            />
            <div
              className={cn(
                'absolute inset-3 rounded-full border transition-all duration-300',
                isSpeaking
                  ? 'border-[var(--accent)]/50'
                  : isCapturing
                    ? 'border-emerald-500/50'
                    : 'border-border/60',
              )}
            />
            {/* Core Astryx Orb */}
            <button
              type="button"
              onClick={isConnected ? toggleMute : () => void handleConnect()}
              className={cn(
                'relative z-10 flex h-24 w-24 items-center justify-center rounded-full shadow-lg transition-transform duration-300 active:scale-95',
                isSpeaking
                  ? 'bg-gradient-to-br from-[#0064E0] via-[#3D87FF] to-[#6366F1] text-white scale-105'
                  : isCapturing
                    ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white'
                    : isConnecting
                      ? 'bg-gradient-to-br from-amber-500 to-orange-500 text-white'
                      : 'bg-gradient-to-br from-foreground/90 to-foreground/70 text-background hover:scale-105',
              )}
              aria-label={isConnected ? 'Toggle microphone mute' : 'Connect voice'}
            >
              {isConnected ? (
                muted ? (
                  <MicOff className="h-8 w-8" />
                ) : isSpeaking ? (
                  <Volume2 className="h-8 w-8" />
                ) : (
                  <Mic className="h-8 w-8" />
                )
              ) : (
                <Sparkles className="h-8 w-8" />
              )}
            </button>
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">{statusHint}</p>

          {/* Controls */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {!isConnected && !isConnecting ? (
              <button
                type="button"
                onClick={() => void handleConnect()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white shadow-sm hover:opacity-90"
              >
                <Mic className="h-3.5 w-3.5" />
                Connect Voice
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleMute}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors',
                    muted
                      ? 'border-amber-500/40 bg-amber-500/12 text-amber-600 dark:text-amber-400'
                      : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  {muted ? 'Muted' : 'Mute'}
                </button>

                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/35 bg-rose-500/10 px-3.5 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
                >
                  <PhoneOff className="h-3.5 w-3.5" />
                  End
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setPushToTalk((v) => !v)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                pushToTalk
                  ? 'border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              Push-to-Talk: {pushToTalk ? 'On' : 'Off'}
            </button>
          </div>

          {pushToTalk && (
            <button
              type="button"
              onMouseDown={() => {
                setPttHeld(true);
                if (mode === 'fallback') startFallbackListening();
                else if (realtime.status === 'connected') {
                  void realtime.resumeAudioCapture();
                }
              }}
              onMouseUp={releasePushToTalk}
              onMouseLeave={releasePushToTalk}
              onTouchStart={() => {
                setPttHeld(true);
                if (mode === 'fallback') startFallbackListening();
                else if (realtime.status === 'connected') {
                  void realtime.resumeAudioCapture();
                }
              }}
              onTouchEnd={releasePushToTalk}
              onTouchCancel={releasePushToTalk}
              className={cn(
                'mt-3 rounded-full px-5 py-2 text-xs font-medium transition-colors select-none',
                pttHeld
                  ? 'bg-emerald-500 text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80',
              )}
            >
              {pttHeld ? 'Release to send' : 'Hold to talk'}
            </button>
          )}
        </div>

        {/* Live Transcript */}
        <div className="min-h-[120px] max-h-48 flex-1 overflow-y-auto border-t border-border/60 bg-muted/20 px-5 py-3">
          {transcriptEntries.length === 0 && !interimText ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Live voice transcript will appear here.
            </div>
          ) : (
            <div className="space-y-2.5">
              {transcriptEntries.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'flex flex-col gap-0.5 text-xs',
                    entry.role === 'user' ? 'items-end' : 'items-start',
                  )}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {entry.role === 'user' ? 'You' : 'Web ADE'}
                  </span>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-[var(--radius-element,12px)] px-3 py-1.5 leading-relaxed',
                      entry.role === 'user'
                        ? 'bg-[var(--accent)] text-white'
                        : 'border border-border/70 bg-background text-foreground',
                    )}
                  >
                    {entry.text}
                  </div>
                </div>
              ))}
              {interimText && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-[var(--radius-element,12px)] bg-muted px-3 py-1.5 text-xs italic text-muted-foreground">
                    {interimText}…
                  </div>
                </div>
              )}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border/60 px-5 py-3">
          <button
            type="button"
            onClick={() => {
              setFallbackTranscript([]);
              setInterimText('');
            }}
            disabled={transcriptEntries.length === 0}
            className="inline-flex items-center gap-1 rounded-[var(--radius-inner,8px)] px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>

          <button
            type="button"
            onClick={handleSendToChat}
            disabled={transcriptEntries.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            Send transcript to chat
          </button>
        </div>
      </div>
    </div>
  );
}
