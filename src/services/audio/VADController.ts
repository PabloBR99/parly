// VADController — glue between AudioCaptureService, VADService, and PipelineOrchestrator.
// Manages continuous listening, speech segment extraction, and anti-echo.
//
// Phase 1 streaming: when the streaming pipeline is available (ACTIVE phase with
// Kroko models loaded), audio chunks are fed to the streaming ASR in real-time
// instead of accumulating a WAV file for offline processing.
//
// Phase 2: uses Silero VAD (neural) when loaded, falls back to energy-based VAD.
//
// Phase 4: on Android, uses native audio capture + VAD (NativeAudioService) to
// eliminate RN bridge crossing for audio data. Falls back to JS-based path on iOS
// or if native module is unavailable.

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { nanoid } from 'nanoid/non-secure';
import { audioCaptureService } from './AudioCaptureService';
import { vadService } from './VADService';
import { sileroVADService } from './SileroVADService';
import { nativeAudioService } from './NativeAudioService';
import { writePcmToWav } from './WavWriter';
import { pipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { streamingPipeline } from '../pipeline/StreamingPipeline';
import { OnlineStreamingSttService } from '../stt/OnlineStreamingSttService';
import { useConversationStore } from '../../store/conversationStore';
import { useAudioLevelStore } from '../../store/audioLevelStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useNetworkStore } from '../../store/networkStore';
import type { PersonId } from '../../app/types';

let segmentCounter = 0;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeVad: (() => void) | null = null;
let unsubscribeNativeChunks: (() => void) | null = null;
let unsubscribeNativeLevel: (() => void) | null = null;
let active = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Per-utterance routing decision.
 *   'online_streaming' — Voxtral realtime WebSocket (needs API key + network).
 *   'offline_streaming' — Kroko dual-stream (needs both languages' models loaded).
 *   'offline_batch'     — accumulate WAV, submit to Whisper at speech_end.
 * Locked at speech_start, respected until speech_end.
 */
type UtteranceMode = 'online_streaming' | 'offline_streaming' | 'offline_batch';
let utteranceMode: UtteranceMode = 'offline_batch';

/** Active online streaming service for the current utterance. */
let onlineStt: OnlineStreamingSttService | null = null;
/** Tracks whether the service's start() has resolved/rejected. null until speech_start. */
let onlineStartPromise: Promise<boolean> | null = null;

/** Whether we're using the native audio path (Android). */
let usingNativeAudio = false;

/** Minimal interface for VAD services — both energy-based and Silero implement this. */
interface VADLike {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  processChunk(base64Pcm: string): void;
  collectSpeechChunks(): string[];
  onEvent(cb: (event: 'speech_start' | 'speech_end') => void): () => void;
}

/** The VAD instance for the current session — captured at startVADMode(). */
let activeVad: VADLike = vadService;

// Delay after TTS finishes before resuming VAD — avoids capturing speaker echo tail
const POST_TTS_COOLDOWN_MS = 500;

/** Silero VAD model path — set by ModelManager after download. */
let sileroModelPath: string | null = null;

export function setSileroModelPath(path: string): void {
  sileroModelPath = path;
}

function nextSegmentPath(): string {
  return `${DocumentDirectoryPath}/vad_segment_${++segmentCounter}.wav`;
}

// ── Online streaming helpers ────────────────────────────────────────────

/**
 * UI convention for MVP online streaming: always route the partial as person_a.
 * Since SubtitleView only shows partials from the OTHER person, the speaker's
 * live transcription appears in person_b's half (top of screen). User looks up
 * while speaking into the mic. When translation is added later we'll derive
 * the actual speaker from audio-LID.
 */
const ONLINE_PARTIAL_SPEAKER: PersonId = 'person_a';

function shouldUseOnlineStreaming(): boolean {
  const { sttTransport, mistralApiKey } = useSettingsStore.getState();
  if (!mistralApiKey) return false;
  if (sttTransport === 'offline') return false;
  if (sttTransport === 'online') return true;
  // 'auto' → only when the monitor has confirmed network
  return useNetworkStore.getState().state === 'online';
}

/**
 * Kick off online streaming for the current utterance. Non-awaited — chunks
 * queue inside the service until session.created. Returns a promise that
 * resolves to true once the transcription is done (via onFinal), or false
 * if start/final failed.
 */
function startOnlineStreaming(): Promise<boolean> {
  const apiKey = useSettingsStore.getState().mistralApiKey;
  const store = useConversationStore.getState();
  const svc = new OnlineStreamingSttService();
  onlineStt = svc;

  let finalFired = false;
  const finalPromise = new Promise<boolean>(resolveFinal => {
    svc.start(
      { apiKey },
      {
        onPartial: (text) => {
          store.setStreamingPartial({
            speakerId: ONLINE_PARTIAL_SPEAKER,
            transcript: text,
            translation: '',
            stableTranslation: '',
          });
        },
        onFinal: (text, language) => {
          store.setStreamingPartial(null);
          finalFired = true;
          const cleaned = text.trim();
          if (cleaned.length > 0) {
            store.addMessage({
              id: nanoid(),
              speakerId: ONLINE_PARTIAL_SPEAKER,
              originalText: cleaned,
              translatedText: null,
              stage: 'done',
              timestamp: Date.now(),
            });
          }
          if (language) {
            store.setDetectedLang(ONLINE_PARTIAL_SPEAKER, language);
          }
          resolveFinal(true);
        },
        onError: (err) => {
          console.error('[VADController] Online streaming runtime error:', err);
          store.setStreamingPartial(null);
          if (!finalFired) resolveFinal(false);
        },
      },
    ).catch((err) => {
      console.error('[VADController] Online streaming start failed:', err);
      store.setStreamingPartial(null);
      resolveFinal(false);
    });
  });

  store.setPipelineStage('streaming');
  return finalPromise;
}

/** Submit accumulated VAD chunks to the batch pipeline (fallback path). */
async function submitBatchFromAccumulated(): Promise<void> {
  if (usingNativeAudio) {
    try {
      const base64Pcm = await nativeAudioService.collectSpeechChunks();
      if (!base64Pcm) return;
      const path = nextSegmentPath();
      await writePcmToWav([base64Pcm], path);
      pipelineOrchestrator.submitAuto(path);
    } catch (e) {
      console.error('[VADController] Batch fallback failed:', e);
    }
  } else {
    const chunks = activeVad.collectSpeechChunks();
    if (chunks.length === 0) return;
    const path = nextSegmentPath();
    try {
      await writePcmToWav(chunks, path);
      pipelineOrchestrator.submitAuto(path);
    } catch (e) {
      console.error('[VADController] Batch fallback failed:', e);
    }
  }
}

/** Discard accumulated VAD chunks without submitting (streaming already handled them). */
function discardAccumulated(): void {
  if (usingNativeAudio) {
    void nativeAudioService.collectSpeechChunks().catch(() => {});
  } else {
    activeVad.collectSpeechChunks();
  }
}

// ── VAD event handler (shared between native and JS paths) ──────────────

function handleVadEvent(event: 'speech_start' | 'speech_end'): void {
  if (event === 'speech_start') {
    // Priority: online streaming > offline streaming > offline batch
    if (shouldUseOnlineStreaming()) {
      utteranceMode = 'online_streaming';
      onlineStartPromise = startOnlineStreaming();
      console.log('[VADController] speech_start — mode: online_streaming');
    } else if (streamingPipeline.isAvailable()) {
      utteranceMode = 'offline_streaming';
      console.log('[VADController] speech_start — mode: offline_streaming');
      void streamingPipeline.startUtterance().catch(e => {
        console.error('[VADController] Offline streaming start failed:', e);
        utteranceMode = 'offline_batch';
      });
    } else {
      utteranceMode = 'offline_batch';
      console.log('[VADController] speech_start — mode: offline_batch');
    }
    return;
  }

  if (event === 'speech_end') {
    const mode = utteranceMode;
    utteranceMode = 'offline_batch'; // reset for next utterance
    console.log('[VADController] speech_end — mode:', mode);

    if (mode === 'online_streaming' && onlineStt) {
      const svc = onlineStt;
      const startPromise = onlineStartPromise;
      onlineStt = null;
      onlineStartPromise = null;

      void (async () => {
        try {
          await svc.end();
        } catch (e) {
          console.error('[VADController] Online end() failed:', e);
        }
        const onlineOk = startPromise ? await startPromise : false;
        if (onlineOk) {
          discardAccumulated();
        } else {
          console.warn('[VADController] Online streaming failed — falling back to batch');
          await submitBatchFromAccumulated();
        }
        useConversationStore.getState().setPipelineStage('idle');
      })();
      return;
    }

    if (mode === 'offline_streaming' && streamingPipeline.isStreaming) {
      discardAccumulated();
      void streamingPipeline.endUtterance().catch(e => {
        console.error('[VADController] Offline streaming end failed:', e);
      });
      return;
    }

    // Fallthrough: offline_batch (or offline_streaming that never attached)
    if (mode === 'offline_streaming') {
      void streamingPipeline.cancelUtterance().catch(() => {});
    }
    void submitBatchFromAccumulated();
  }
}

// ── Anti-echo: pause/resume on TTS stages ───────────────────────────────

function setupAntiEcho(): void {
  unsubscribeStore = useConversationStore.subscribe((state, prevState) => {
    if (state.pipelineStage === prevState.pipelineStage) return;

    const stage = state.pipelineStage;
    if (stage === 'synthesizing' || stage === 'streaming_tts' || stage === 'playing') {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      if (usingNativeAudio) {
        void nativeAudioService.pauseCapture();
      } else {
        activeVad.pause();
      }
    } else if (stage === 'idle') {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (active) {
          if (usingNativeAudio) {
            void nativeAudioService.resumeCapture();
          } else {
            activeVad.resume();
          }
          useConversationStore.getState().setPipelineStage('listening');
        }
      }, POST_TTS_COOLDOWN_MS);
    }
  });
}

// ── Start / Stop ────────────────────────────────────────────────────────

export function startVADMode(): void {
  if (active) return;
  active = true;

  // Try native audio first (Android) — eliminates bridge crossing
  if (nativeAudioService.isAvailable && sileroModelPath) {
    console.log('[VADController] Attempting native audio capture + VAD');

    // Start native capture asynchronously — only subscribe after success
    // to avoid leaking subscriptions if the native start fails.
    void (async () => {
      try {
        await nativeAudioService.attachVad(sileroModelPath!);
        await nativeAudioService.startCapture(true);

        // Success — set flag and wire up subscriptions
        if (!active) return; // stopVADMode() called during await
        usingNativeAudio = true;

        unsubscribeVad = nativeAudioService.onVadEvent(handleVadEvent);
        unsubscribeNativeChunks = nativeAudioService.onAudioChunk(base64Pcm => {
          if (utteranceMode === 'online_streaming' && onlineStt) {
            onlineStt.feedAudio(base64Pcm);
          } else if (utteranceMode === 'offline_streaming' && streamingPipeline.isStreaming) {
            void streamingPipeline.feedAudioChunk(base64Pcm).catch(() => {});
          }
        });
        unsubscribeNativeLevel = nativeAudioService.onAudioLevel(level => {
          useAudioLevelStore.getState().setLevel(level * 8);
        });

        setupAntiEcho();
        console.log('[VADController] Using native audio capture + VAD');
      } catch (e) {
        console.error('[VADController] Native audio start failed, falling back to JS:', e);
        if (!active) return;
        usingNativeAudio = false;
        startJSPath();
      }
    })();

    useConversationStore.getState().setPipelineStage('listening');
    return;
  }

  // JS fallback path
  usingNativeAudio = false;
  startJSPath();
  useConversationStore.getState().setPipelineStage('listening');
}

function startJSPath(): void {
  // Pick Silero if loaded, otherwise energy-based — locked for this session
  activeVad = sileroVADService.isLoaded ? sileroVADService : vadService;
  console.log('[VADController] Using', sileroVADService.isLoaded ? 'Silero' : 'energy-based', 'VAD (JS path)');
  activeVad.start();

  setupAntiEcho();

  // Handle VAD events
  unsubscribeVad = activeVad.onEvent(handleVadEvent);

  // Start continuous audio streaming → VAD + streaming ASR
  audioCaptureService.startStreaming(base64Pcm => {
    activeVad.processChunk(base64Pcm);

    if (utteranceMode === 'online_streaming' && onlineStt) {
      onlineStt.feedAudio(base64Pcm);
    } else if (utteranceMode === 'offline_streaming' && streamingPipeline.isStreaming) {
      void streamingPipeline.feedAudioChunk(base64Pcm).catch(() => {});
    }
  });
}

export function stopVADMode(): void {
  if (!active) return;
  active = false;

  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  // Cancel any in-flight streaming utterance
  void streamingPipeline.cancelUtterance().catch(() => {});
  onlineStt?.cancel();
  onlineStt = null;
  onlineStartPromise = null;

  if (usingNativeAudio) {
    void nativeAudioService.stopCapture();
    void nativeAudioService.detachVad();
  } else {
    void audioCaptureService.stopStreaming();
    activeVad.stop();
  }

  unsubscribeStore?.();
  unsubscribeVad?.();
  unsubscribeNativeChunks?.();
  unsubscribeNativeLevel?.();
  unsubscribeStore = null;
  unsubscribeVad = null;
  unsubscribeNativeChunks = null;
  unsubscribeNativeLevel = null;
  utteranceMode = 'offline_batch';
  usingNativeAudio = false;

  useConversationStore.getState().setPipelineStage('idle');
}

export function isVADActive(): boolean {
  return active;
}
