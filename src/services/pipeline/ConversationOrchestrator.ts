// ConversationOrchestrator — owns the per-turn state machine for Parly v4.
//
// One turn ≡ one half-duplex push-to-talk:
//
//   user holds mic ─┬─► capture starts ──► Voxtral WS streams audio ──► partials update UI
//                   │
//   user releases ──┴─► capture stops ──► Voxtral final ──► Mistral translation SSE
//                                                                  │
//                                                                  ▼ (per sentence)
//                                                     react-native-tts speakChunk (queues)
//                                                                  │
//                                                                  ▼ (Promise.all)
//                                                              turn marked done
//
// Hands-free (HF) mode:
//   A single Voxtral WS (sessionMode) stays open across multiple utterances.
//   Silero VAD fires speech_start / speech_end; on speech_end we call
//   flushUtterance() to get the transcript, route by detected language, and
//   dispatch through the existing Mistral → TTS pipeline.
//
//   HF state machine:
//     hf-idle → hf-capturing → hf-flushing → hf-routing → hf-speaking
//             ↑                                          |           |
//             └──────────────── hf-cooldown (250 ms) ───┘           │
//                               ← lang ∉ pair (discard) ────────────┘
//
// Why dependency-injection?
//   The orchestrator owns the half-duplex lock and is the most error-prone
//   component, so it MUST be unit-testable without WebSockets, fetch, or
//   Android TTS. Every collaborator is an interface.

import { useConversationStore } from '../../store/conversationStore';
import type { HfActivity } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { log } from '../log/logStore';
import { classifyError } from './errors';
import { probeNetworkNow } from '../network/monitor';

/** Tiny non-cryptographic ID generator. */
function turnId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Collaborator interfaces ──────────────────────────────────────────────────

export interface AudioCapture {
  /** Non-interactive permission check — must never show a dialog. */
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  startStreaming(onData: (base64Pcm: string) => void): void;
  stopStreaming(): Promise<void>;
}

export interface VoxtralLike {
  start(
    options: { apiKey: string; model?: string; sessionMode?: boolean },
    callbacks: {
      onPartial: (text: string) => void;
      onFinal: (text: string, language?: string) => void;
      onError: (err: Error) => void;
    },
  ): Promise<void>;
  feedAudio(base64Pcm: string): void;
  end(timeoutMs?: number): Promise<void>;
  cancel(): void;
  // Session-mode only (optional — not available in PTT mocks):
  flushUtterance?(timeoutMs?: number): Promise<{ text: string; language?: string }>;
  endSession?(): Promise<void>;
  /** Drop text accumulated since the last flush (TTS echo scrubbing). */
  resetUtterance?(): void;
}

export interface TranslatorLike {
  prewarm(args: { apiKey: string; model?: string }): Promise<void>;
  translateStream(args: {
    apiKey: string;
    sourceText: string;
    sourceLang: string;
    targetLang: string;
    model?: string;
    signal?: AbortSignal;
    onFirstToken?: () => void;
    /** Full translated text so far, on every delta — drives live display. */
    onDelta?: (fullTextSoFar: string) => void;
    onSentence: (sentence: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

/** Mirrors NativeTTSService.SpeakOutcome without importing the concrete
 *  service — the orchestrator only depends on interfaces. */
export type TTSSpeakOutcome = 'spoken' | 'no-voice' | 'error' | 'skipped';

export interface TTSLike {
  init(): Promise<void>;
  prewarm(language: string): void;
  speakChunk(text: string, language: string): Promise<TTSSpeakOutcome>;
  stop(): void;
}

export interface VadLike {
  initialize(): Promise<void>;
  feedFrame(pcmInt16: Int16Array): void;
  subscribe(onSpeechStart: () => void, onSpeechEnd: () => void): () => void;
  setActive(active: boolean): void;
  resetState(): void;
  destroy(): void;
}

// ── State machine ────────────────────────────────────────────────────────────

export type OrchestratorState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'translating'
  | 'speaking';

export type HfState =
  | 'hf-idle'
  | 'hf-capturing'
  | 'hf-flushing'
  | 'hf-routing'
  | 'hf-speaking'
  | 'hf-cooldown';

export interface BeginTurnArgs {
  readonly speakerId: PersonId;
  readonly sourceLang: string;
  readonly targetLang: string;
}

export interface OrchestratorConfig {
  readonly apiKey: string;
  readonly translationModel: string;
  readonly sttModel?: string;
}

interface OrchestratorDeps {
  readonly audioCapture: AudioCapture;
  readonly voxtral: VoxtralLike;
  readonly translator: TranslatorLike;
  readonly tts: TTSLike;
  readonly vad?: VadLike;
  readonly conversationStore?: typeof useConversationStore;
}

const DEFAULT_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
/** PCM samples per VAD frame (512 @ 16 kHz = 32 ms). */
const VAD_FRAME_SAMPLES = 512;
/** Grace period between PTT release and mic stop. People release the disc ON
 *  the last syllable, not after it — without this, the word that matters most
 *  gets clipped. The turn is already showing 'transcribing' during it. */
const PTT_RELEASE_HANGOVER_MS = 250;
/** Cooldown after TTS finishes before re-enabling VAD (matches
 *  PTT_RELEASE_HANGOVER_MS). */
const HF_COOLDOWN_MS = 250;
/** Min interval between store writes driven by translation deltas. Deltas can
 *  arrive faster than the UI can usefully paint; one write per ~80 ms keeps
 *  text visibly streaming without hammering every subscriber. */
const DELTA_WRITE_THROTTLE_MS = 80;
/** Hard cap on accumulated VAD samples (1 s @ 16 kHz). Prevents heap growth
 *  if the inferencer wedges and stops draining. */
const MAX_VAD_BUFFER_SAMPLES = 16_000;

export class ConversationOrchestrator {
  // PTT state
  private state: OrchestratorState = 'idle';
  private activeTurnId: string | null = null;
  private currentArgs: BeginTurnArgs | null = null;
  private config: OrchestratorConfig | null = null;
  /** Guards the async permission check in beginTurn — the only await between
   *  the idle check and state='recording', so two simultaneous presses can't
   *  both pass the gate. */
  private beginning = false;
  private ttsChunkPromises: Promise<void>[] = [];
  private translationAbort: AbortController | null = null;
  private turnCompletionPromise: Promise<void> | null = null;
  private resolveTurnCompletion: (() => void) | null = null;
  /** Target languages we've already shown the "no voice installed" notice
   *  for — once per language per session is enough. */
  private voiceNoticeShown = new Set<string>();

  // HF state
  private hfEnabled = false;
  private hfPaused = false;
  private hfState: HfState = 'hf-idle';
  private hfVadUnsub: (() => void) | null = null;
  private hfPairA: string | null = null;  // language code for person_a
  private hfPairB: string | null = null;  // language code for person_b
  private vadBuffer: Int16Array = new Int16Array(0);
  private hfFirstAudioLogged = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Read-only PTT state for UI debugging. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Read-only HF state for UI debugging. */
  getHfState(): HfState {
    return this.hfState;
  }

  /**
   * Single funnel for HF state transitions. Updates the internal state AND
   * mirrors the derived "activity" onto the store so the seam voice wave
   * (`SeamControl`) can breathe in step: capturing → listening, speaking →
   * speaking, everything else → idle. Routing all `hfState` writes through
   * here keeps the wave and the machine from drifting apart.
   */
  private setHfState(next: HfState): void {
    this.hfState = next;
    const activity: HfActivity =
      next === 'hf-capturing' ? 'listening'
      : next === 'hf-speaking' ? 'speaking'
      : 'idle';
    (this.deps.conversationStore ?? useConversationStore).getState().setHfActivity(activity);
  }

  /** Whether hands-free mode is currently active. */
  isHandsFreeActive(): boolean {
    return this.hfEnabled;
  }

  /** Update the API key / model. Safe to call between turns. */
  configure(config: OrchestratorConfig): void {
    this.config = config;
  }

  /**
   * Best-effort warmup: TTS engine init + an HTTP/2 ping to api.mistral.ai
   * to open the TLS session. Saves ~150-300 ms on the first real translation.
   */
  async prewarm(): Promise<void> {
    await this.deps.tts.init();
    if (this.config?.apiKey) {
      await this.deps.translator.prewarm({
        apiKey: this.config.apiKey,
        model: this.config.translationModel,
      });
    }
  }

  /** Begin a PTT turn. Returns a Promise that resolves when the FULL turn
   *  (STT + translation + TTS) completes. Idempotent if already in a turn. */
  async beginTurn(args: BeginTurnArgs): Promise<void> {
    if (this.hfEnabled) {
      log.warn('[orch] beginTurn ignored — hands-free mode active');
      return;
    }
    if (this.state !== 'idle' || this.beginning) {
      log.warn(`[orch] beginTurn ignored — state=${this.state}`);
      return;
    }
    if (!this.config?.apiKey) {
      log.error('[orch] beginTurn: no API key configured');
      throw new Error('Orchestrator not configured (missing API key)');
    }
    const cfg = this.config;
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    // A fresh press is the reader acting on the last notice — clear it.
    store.setNotice(args.speakerId, null);

    // Mic permission, lazily and in context (not fire-and-forget at launch).
    // If the system dialog appears, this press has physically ended under it,
    // so we never start recording on the same press — grant means the NEXT
    // press works; denial gets a speaker-side notice with the fix.
    this.beginning = true;
    try {
      let granted: boolean;
      try {
        granted = await this.deps.audioCapture.hasPermission();
      } catch {
        granted = true; // permission APIs unavailable — let the platform decide
      }
      if (!granted) {
        const nowGranted = await this.deps.audioCapture.requestPermission().catch(() => false);
        if (!nowGranted) {
          store.setNotice(args.speakerId, { key: 'micPermission', kind: 'info' });
        }
        return;
      }
    } finally {
      this.beginning = false;
    }

    log.info(`[orch] beginTurn speaker=${args.speakerId} ${args.sourceLang}→${args.targetLang}`);

    const id = turnId();
    store.startTurn({
      id,
      speakerId: args.speakerId,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      sourceText: '',
      translatedText: '',
      stage: 'recording',
      startedAt: Date.now(),
    });

    this.state = 'recording';
    this.activeTurnId = id;
    this.currentArgs = args;
    this.ttsChunkPromises = [];
    this.turnCompletionPromise = new Promise<void>((resolve) => {
      this.resolveTurnCompletion = resolve;
    });

    this.deps.tts.prewarm(args.targetLang);

    try {
      this.deps.audioCapture.startStreaming((base64Pcm) => {
        this.deps.voxtral.feedAudio(base64Pcm);
      });
    } catch (e) {
      this.failTurn(id, `Audio capture failed: ${stringifyError(e)}`);
      return;
    }

    try {
      await this.deps.voxtral.start(
        { apiKey: cfg.apiKey, model: cfg.sttModel ?? DEFAULT_STT_MODEL },
        {
          onPartial: (text) => this.handlePartial(id, text),
          onFinal: (text) => this.handleFinal(id, text),
          onError: (err) => this.failTurn(id, err.message),
        },
      );
    } catch (e) {
      // A quick release no longer aborts the handshake (the client flushes
      // the queued audio when the session opens), so a rejection here is a
      // real connection failure regardless of PTT state — surface it.
      log.error('[orch] Voxtral handshake rejected', e instanceof Error ? e : new Error(String(e)));
      void this.deps.audioCapture.stopStreaming().catch(() => {});
      this.failTurn(id, `Voxtral handshake failed: ${stringifyError(e)}`);
      return;
    }

    return this.turnCompletionPromise;
  }

  /** End the user's speaking phase (PTT release). */
  async endTurn(): Promise<void> {
    if (this.state !== 'recording') return;
    this.state = 'transcribing';
    const id = this.activeTurnId;
    if (id) {
      const store = (this.deps.conversationStore ?? useConversationStore).getState();
      store.updateTurn(id, { stage: 'transcribing' });
    }

    // Release hangover: capture the syllable the release landed on. The UI
    // already shows 'transcribing', so the extra 250 ms is honest.
    await new Promise<void>((r) => setTimeout(r, PTT_RELEASE_HANGOVER_MS));

    try {
      await this.deps.audioCapture.stopStreaming();
    } catch (e) {
      console.warn('[Orchestrator] stopStreaming failed:', e);
    }
    try {
      await this.deps.voxtral.end();
    } catch (e) {
      if (id) this.failTurn(id, `Voxtral end failed: ${stringifyError(e)}`);
    }
  }

  /**
   * Abort the current PTT turn — the user's own act (tapping the reading to
   * stop it, backgrounding the app). Ends quietly as 'done' with whatever
   * text already arrived: no error stage, no notice, no error haptic.
   */
  async cancelTurn(): Promise<void> {
    if (this.state === 'idle') return;
    const id = this.activeTurnId;
    try { this.translationAbort?.abort(); } catch { /* noop */ }
    try { await this.deps.audioCapture.stopStreaming().catch(() => {}); } catch { /* noop */ }
    try { this.deps.voxtral.cancel(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
    if (id) {
      const store = (this.deps.conversationStore ?? useConversationStore).getState();
      store.endTurn(id, { stage: 'done' });
      this.completeTurn(id);
    }
  }

  // ── Hands-Free API ────────────────────────────────────────────────────────

  /**
   * Activate hands-free mode:
   *   1. Initialize VAD (loads the ONNX model on first call).
   *   2. Start audio capture with dual-path routing (→ Voxtral, → VAD).
   *   3. Open a persistent Voxtral session (sessionMode=true).
   *   4. Subscribe to VAD events to drive the HF state machine.
   */
  async enableHandsFree(pairA: string, pairB: string): Promise<void> {
    if (this.hfEnabled) return;
    if (this.state !== 'idle') throw new Error('Cannot enable hands-free during an active PTT turn');
    if (!this.config?.apiKey) throw new Error('Orchestrator not configured (missing API key)');
    if (!this.deps.vad) throw new Error('No VAD service configured');

    // Mic permission, checked BEFORE anything flips to hands-free.
    // AudioRecord.start() without RECORD_AUDIO dies in native code — no JS
    // try/catch sees it, the process just ends. Unlike a PTT press (which
    // physically ends under the system dialog), the toggle tap survives the
    // dialog, so a grant can continue straight into hands-free.
    let granted: boolean;
    try {
      granted = await this.deps.audioCapture.hasPermission();
    } catch {
      granted = true; // permission APIs unavailable — let the platform decide
    }
    if (!granted) {
      granted = await this.deps.audioCapture.requestPermission().catch(() => false);
    }
    if (!granted) {
      // The toggle isn't owned by either speaker — both readers see why
      // hands-free didn't start, each in their own language.
      const s = (this.deps.conversationStore ?? useConversationStore).getState();
      s.setNotice('person_a', { key: 'micPermission', kind: 'info' });
      s.setNotice('person_b', { key: 'micPermission', kind: 'info' });
      return;
    }

    const cfg = this.config;
    log.info(`[orch/hf] enabling — pair=${pairA}↔${pairB}`);

    this.hfPairA = pairA;
    this.hfPairB = pairB;
    this.hfEnabled = true;
    this.setHfState('hf-idle');
    this.vadBuffer = new Int16Array(0);
    this.hfFirstAudioLogged = false;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setMode('hf');

    // 1. Init VAD (no-op on subsequent calls).
    await this.deps.vad.initialize();

    // 2. Start audio capture with dual routing. Stop first to guarantee a clean
    //    state — a failed PTT turn may have left streaming=true (failTurn path).
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
    this.deps.audioCapture.startStreaming(this.hfOnAudio);

    // 3. Open persistent Voxtral session.
    await this.deps.voxtral.start(
      {
        apiKey: cfg.apiKey,
        model: cfg.sttModel ?? DEFAULT_STT_MODEL,
        sessionMode: true,
      },
      {
        onPartial: (text) => this.handleHfPartial(text),
        onFinal: () => { /* resolved via flushUtterance — this is informational only */ },
        onError: (err) => this.handleHfError(err),
      },
    );

    // 4. Subscribe to VAD events.
    this.hfVadUnsub = this.deps.vad.subscribe(
      () => this.handleHfSpeechStart(),
      () => void this.handleHfSpeechEnd(),
    );

    // Reset RNN state so stale state from a previous session doesn't suppress
    // speech detection at the start of the new one.
    this.deps.vad.resetState();
    // Always re-arm VAD on enable — disableHandsFree leaves it inactive.
    this.deps.vad.setActive(true);

    log.info('[orch/hf] enabled — listening');
  }

  /**
   * Deactivate hands-free mode. Safe to call from any HF sub-state.
   * Cleans up VAD subscription, Voxtral session, and audio capture.
   *
   * Ordering: clear UI flags FIRST so the toggle and discs snap back
   * instantly, then tear down resources. If audioCapture.stopStreaming
   * stalls on Android (it has happened in production), the UI is still
   * coherent.
   */
  async disableHandsFree(): Promise<void> {
    if (!this.hfEnabled) return;
    log.info('[orch/hf] disabling');

    this.hfPaused = false;
    this.hfEnabled = false;
    this.setHfState('hf-idle');

    // 1. Clear UI state synchronously — UI is coherent before any await.
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setMode('ptt');
    store.setHfActiveSpeaker(null);
    store.setHfUnroutedSpeaker(null);

    // 2. Stop VAD subscription.
    this.hfVadUnsub?.();
    this.hfVadUnsub = null;
    this.deps.vad?.setActive(false);

    // 3. Stop audio capture.
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }

    // 4. Close Voxtral session.
    try {
      if (this.deps.voxtral.endSession) {
        await this.deps.voxtral.endSession();
      } else {
        this.deps.voxtral.cancel();
      }
    } catch (e) {
      log.error('[orch/hf] endSession failed', e instanceof Error ? e : new Error(String(e)));
    }

    // 5. Stop any TTS in flight.
    try { this.deps.tts.stop(); } catch { /* noop */ }

    this.hfPairA = null;
    this.hfPairB = null;
    this.vadBuffer = new Int16Array(0);

    log.info('[orch/hf] disabled');
  }

  /**
   * Pause hands-free without tearing down the session — used when the device
   * loses connectivity. Stops the mic and disarms VAD; keeps `hfEnabled=true`
   * so the UI still reflects HF mode (with a "paused — offline" microcopy).
   * Safe to call when already paused or when HF is not active.
   */
  async pauseHandsFree(): Promise<void> {
    if (!this.hfEnabled || this.hfPaused) return;
    log.info('[orch/hf] pausing — network offline');
    this.hfPaused = true;
    this.setHfState('hf-idle');
    this.vadBuffer = new Int16Array(0);
    this.deps.vad?.setActive(false);
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
  }

  /**
   * Resume hands-free after a pause — restarts audio capture with the same
   * dual routing and re-arms VAD. Safe to call when not paused.
   */
  async resumeHandsFree(): Promise<void> {
    if (!this.hfEnabled || !this.hfPaused) return;
    log.info('[orch/hf] resuming — network online');
    try {
      this.deps.audioCapture.startStreaming(this.hfOnAudio);
    } catch (e) {
      log.error('[orch/hf] resume audio capture failed', e instanceof Error ? e : new Error(String(e)));
      // Leave paused so UI can offer a manual disable.
      return;
    }
    this.hfPaused = false;
    this.deps.vad?.setActive(true);
  }

  /** Whether hands-free is currently paused (e.g. due to offline). */
  isHandsFreePaused(): boolean {
    return this.hfPaused;
  }

  // ── HF internal state machine ─────────────────────────────────────────────

  /**
   * Dual-path HF capture callback. While the phone is speaking (and during
   * cooldown) the mic is hearing the phone's own TTS — that audio must NOT
   * reach the Voxtral session, or the accumulator grows an echo prefix the
   * router later detects as the other language (a feedback-loop ingredient).
   * VOICE_COMMUNICATION's AEC is too device-dependent to rely on alone.
   */
  private readonly hfOnAudio = (base64Pcm: string): void => {
    if (this.hfState !== 'hf-speaking' && this.hfState !== 'hf-cooldown') {
      this.deps.voxtral.feedAudio(base64Pcm);
    }
    this.feedAudioToVad(base64Pcm);
  };

  private handleHfSpeechStart(): void {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-idle') return;
    log.info('[orch/hf] speech_start → capturing');
    this.setHfState('hf-capturing');
  }

  private async handleHfSpeechEnd(): Promise<void> {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-capturing') return;
    if (!this.deps.voxtral.flushUtterance) return;

    const vadEndAt = Date.now();
    log.info('[orch/hf] speech_end → flushing');
    this.setHfState('hf-flushing');

    let result: { text: string; language?: string };
    const flushSentAt = Date.now();
    try {
      result = await this.deps.voxtral.flushUtterance(3_000);
    } catch (e) {
      log.error('[orch/hf] flushUtterance failed', e instanceof Error ? e : new Error(String(e)));
      if (this.hfEnabled) {
        this.setHfState('hf-idle');
        await this.attemptHfReconnect();
      }
      return;
    }
    const flushedAt = Date.now();

    if (!this.hfEnabled) return;

    const { text, language } = result;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.setHfState('hf-idle');
      return;
    }

    // Route by detected language.
    const routing = this.routeUtterance(language ?? null, trimmed);
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!routing) {
      // Mismatched/discarded — emit compact telemetry if we have pair context.
      if (pairA && pairB) {
        log.info(
          `[hf_turn] ${JSON.stringify({
            kind: 'hf_turn',
            routedLanguage: language ?? null,
            configuredPair: [pairA, pairB],
            routingResult: 'mismatched',
            utteranceWordCount: trimmed.split(/\s+/).filter(Boolean).length,
          })}`,
        );
      }
      this.setHfState('hf-idle');
      return;
    }

    const { speakerId, sourceLang, targetLang, kind: routingKind } = routing;
    this.setHfState('hf-routing');

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setHfActiveSpeaker(speakerId);

    await this.dispatchHfTurn(speakerId, sourceLang, targetLang, trimmed, {
      vadEndAt,
      flushSentAt,
      flushedAt,
      routedLanguage: language ?? null,
      configuredPair: [pairA ?? '', pairB ?? ''],
      routingResult: routingKind,
    });

    if (this.hfEnabled) {
      store.setHfActiveSpeaker(null);
      this.setHfState('hf-cooldown');
      await new Promise<void>((r) => setTimeout(r, HF_COOLDOWN_MS));
      if (this.hfEnabled && !this.hfPaused) {
        // Scrub whatever leaked past the capture gate (chunks in flight when
        // the state flipped) before listening for the next speaker.
        this.deps.voxtral.resetUtterance?.();
        this.setHfState('hf-idle');
        this.deps.vad?.setActive(true);
      } else if (this.hfEnabled) {
        this.setHfState('hf-idle');
      }
    }
  }

  private routeUtterance(
    detectedLang: string | null,
    text: string,
  ): {
    speakerId: PersonId;
    sourceLang: string;
    targetLang: string;
    kind: 'matched' | 'fallback';
  } | null {
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!pairA || !pairB) return null;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();

    if (detectedLang) {
      // Compare BCP-47 primary subtags so "es-MX" matches "es" symmetrically
      // and a regional pair like (es, es-MX) doesn't always route to A.
      const dl = primarySubtag(detectedLang);
      const a  = primarySubtag(pairA);
      const b  = primarySubtag(pairB);

      if (a !== b) {
        if (dl === a) {
          return { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind: 'matched' };
        }
        if (dl === b) {
          return { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind: 'matched' };
        }
      } else {
        // Same primary subtag both sides — language alone can't disambiguate.
        // Fall through to alternation.
      }

      if (a !== b) {
        // Language not in pair — discard with visual feedback on the side
        // whose turn it likely was (alternate from last routed).
        log.info(`[orch/hf] unrouted utterance lang=${detectedLang} text="${text.slice(0, 30)}"`);
        const lastDone = [...store.turns].reverse().find(t => t.stage === 'done');
        const flashSide: PersonId = lastDone?.speakerId === 'person_a' ? 'person_b' : 'person_a';
        store.setHfUnroutedSpeaker(flashSide);
        setTimeout(() => {
          if (this.hfEnabled) store.setHfUnroutedSpeaker(null);
        }, 600);
        return null;
      }
    }

    // No language tag (or ambiguous same-subtag pair) — alternate from last
    // routed turn. First turn defaults to person_a.
    const lastDone = [...store.turns].reverse().find(t => t.stage === 'done');
    if (lastDone?.speakerId === 'person_a') {
      return { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind: 'fallback' };
    }
    return { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind: 'fallback' };
  }

  private async dispatchHfTurn(
    speakerId: PersonId,
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    telemetry: {
      vadEndAt: number;
      flushSentAt: number;
      flushedAt: number;
      routedLanguage: string | null;
      configuredPair: [string, string];
      routingResult: 'matched' | 'fallback';
    },
  ): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;

    const id = turnId();
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.startTurn({
      id,
      speakerId,
      sourceLang,
      targetLang,
      sourceText,
      translatedText: '',
      stage: 'translating',
      startedAt: Date.now(),
    });

    this.setHfState('hf-speaking');
    this.deps.tts.prewarm(targetLang);
    this.deps.vad?.setActive(false);

    const abort = new AbortController();
    const listenerId: PersonId = speakerId === 'person_a' ? 'person_b' : 'person_a';
    const ttsPromises: Promise<void>[] = [];
    let firstTokenAt: number | null = null;
    let firstTtsStartAt: number | null = null;
    let lastDeltaWriteAt = 0;

    await this.deps.translator.translateStream({
      signal: abort.signal,
      apiKey: cfg.apiKey,
      sourceText,
      sourceLang,
      targetLang,
      model: cfg.translationModel,
      onFirstToken: () => {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        this.deps.tts.prewarm(targetLang);
      },
      onDelta: (fullSoFar) => {
        if (!this.hfEnabled) return;
        const now = Date.now();
        if (now - lastDeltaWriteAt < DELTA_WRITE_THROTTLE_MS) return;
        lastDeltaWriteAt = now;
        store.updateTurn(id, { translatedText: fullSoFar.trim() });
      },
      onSentence: (sentence) => {
        if (!this.hfEnabled) { abort.abort(); return; }
        if (firstTtsStartAt === null) firstTtsStartAt = Date.now();
        store.updateTurn(id, { stage: 'speaking' });
        ttsPromises.push(
          this.deps.tts
            .speakChunk(sentence, targetLang)
            .then((outcome) => {
              if (outcome === 'no-voice') this.noteNoVoice(targetLang, listenerId);
            })
            .catch((e) => {
              console.warn('[orch/hf] TTS chunk error:', e);
            }),
        );
      },
      onDone: (fullText) => {
        store.updateTurn(id, { translatedText: fullText.trim() });
      },
      onError: (err) => {
        log.error('[orch/hf] translation error', err);
        store.endTurn(id, { stage: 'error', errorMessage: err.message });
        const key = classifyError(err.message);
        if (key) store.setNotice(speakerId, { key, kind: 'error' });
        probeNetworkNow();
      },
    });

    await Promise.all(ttsPromises);
    const endAt = Date.now();

    if (store.turns.find(t => t.id === id)?.stage !== 'error') {
      store.endTurn(id, { stage: 'done' });
    }

    // Phase 4 — structured HF turn telemetry (§11). Single emit per turn.
    const finalAt = telemetry.flushedAt;
    const payload = {
      kind: 'hf_turn' as const,
      vadEndToFlush: telemetry.flushSentAt - telemetry.vadEndAt,
      flushToFinal: finalAt - telemetry.flushSentAt,
      finalToFirstToken: firstTokenAt !== null ? firstTokenAt - finalAt : -1,
      firstTokenToFirstTtsStart:
        firstTokenAt !== null && firstTtsStartAt !== null
          ? firstTtsStartAt - firstTokenAt
          : -1,
      totalTurnDuration: endAt - telemetry.vadEndAt,
      routedLanguage: telemetry.routedLanguage,
      configuredPair: telemetry.configuredPair,
      routingResult: telemetry.routingResult,
      utteranceWordCount: sourceText.split(/\s+/).filter(Boolean).length,
    };
    log.info(`[hf_turn] ${JSON.stringify(payload)}`);
  }

  private handleHfPartial(_text: string): void {
    // No-op for now: HF partials arrive during 'hf-capturing', but we don't
    // create the store turn until flushUtterance resolves and language has
    // been routed. Writing partials to the previous (already-done) turn
    // would flicker its sourceText. If we want live partials in HF, we need
    // a separate transient store field rather than reusing activeTurnId.
  }

  private handleHfError(err: Error): void {
    log.error('[orch/hf] Voxtral error', err);
    if (!this.hfEnabled) return;
    void this.attemptHfReconnect();
  }

  private async attemptHfReconnect(): Promise<void> {
    const cfg = this.config;
    if (!cfg || !this.hfEnabled) return;

    // Pause VAD + drain buffer so stale frames don't trigger speech_start
    // against a half-open or freshly-reconnected session.
    this.deps.vad?.setActive(false);
    this.vadBuffer = new Int16Array(0);
    this.setHfState('hf-idle');

    log.info('[orch/hf] reconnecting in 500 ms');
    await new Promise<void>((r) => setTimeout(r, 500));
    if (!this.hfEnabled) return;

    try {
      await this.deps.voxtral.start(
        { apiKey: cfg.apiKey, model: cfg.sttModel ?? DEFAULT_STT_MODEL, sessionMode: true },
        {
          onPartial: (text) => this.handleHfPartial(text),
          onFinal: () => {},
          onError: (err) => {
            log.error('[orch/hf] reconnect failed, disabling HF', err);
            void this.disableHandsFree();
          },
        },
      );
      // Re-arm VAD only after the new session is open.
      this.deps.vad?.setActive(true);
      log.info('[orch/hf] reconnected');
    } catch (e) {
      log.error('[orch/hf] reconnect attempt failed', e instanceof Error ? e : new Error(String(e)));
      void this.disableHandsFree();
    }
  }

  // ── VAD audio routing ─────────────────────────────────────────────────────

  private feedAudioToVad(base64Pcm: string): void {
    if (!this.deps.vad || !this.hfEnabled || this.hfPaused) return;

    if (!this.hfFirstAudioLogged) {
      this.hfFirstAudioLogged = true;
      log.info('[orch/hf] audio→vad: first chunk received');
    }

    // Decode base64 → bytes → Int16 PCM. Round byteLength down to the
    // nearest even count so a malformed/truncated chunk doesn't throw
    // RangeError when constructing the Int16Array.
    const binaryStr = atob(base64Pcm);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const safeLen = bytes.byteLength & ~1;
    if (safeLen === 0) return;
    const incoming = new Int16Array(bytes.buffer, 0, safeLen / 2);

    // Append to frame buffer and drain 512-sample frames. Cap the buffer
    // at MAX_VAD_BUFFER samples so a wedged inferencer can't OOM the heap.
    const merged = new Int16Array(this.vadBuffer.length + incoming.length);
    merged.set(this.vadBuffer);
    merged.set(incoming, this.vadBuffer.length);
    this.vadBuffer =
      merged.length > MAX_VAD_BUFFER_SAMPLES
        ? merged.slice(merged.length - MAX_VAD_BUFFER_SAMPLES)
        : merged;

    while (this.vadBuffer.length >= VAD_FRAME_SAMPLES) {
      const frame = this.vadBuffer.slice(0, VAD_FRAME_SAMPLES);
      try {
        this.deps.vad.feedFrame(frame);
      } catch (e) {
        log.error('[orch/hf] VAD feedFrame threw', e instanceof Error ? e : new Error(String(e)));
        // Drain rest of buffer rather than spamming the same broken inferencer.
        this.vadBuffer = new Int16Array(0);
        return;
      }
      this.vadBuffer = this.vadBuffer.slice(VAD_FRAME_SAMPLES);
    }
  }

  // ── PTT internal handlers ─────────────────────────────────────────────────

  private handlePartial(turnId: string, partial: string): void {
    if (turnId !== this.activeTurnId) return;
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.updateTurn(turnId, { sourceText: partial });
  }

  private handleFinal(turnId: string, finalText: string): void {
    if (turnId !== this.activeTurnId) return;
    void this.dispatchTranslation(turnId, finalText).catch((e) => {
      this.failTurn(turnId, `Pipeline error: ${stringifyError(e)}`);
    });
  }

  private async dispatchTranslation(turnId: string, finalText: string): Promise<void> {
    const args = this.currentArgs;
    const cfg = this.config;
    if (!args || !cfg) return;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    const trimmed = finalText.trim();
    if (trimmed.length === 0) {
      // "Did it hear me?" must never be left open: an empty transcript gets
      // a quiet speaker-side notice instead of vanishing without a trace.
      store.endTurn(turnId, { sourceText: '', translatedText: '', stage: 'done' });
      store.setNotice(args.speakerId, { key: 'didntCatch', kind: 'info' });
      this.completeTurn(turnId);
      return;
    }
    store.updateTurn(turnId, { sourceText: trimmed, stage: 'translating' });
    this.state = 'translating';

    const abort = new AbortController();
    this.translationAbort = abort;

    const listenerId: PersonId = args.speakerId === 'person_a' ? 'person_b' : 'person_a';
    let translationFailed = false;
    let lastDeltaWriteAt = 0;

    await this.deps.translator.translateStream({
      signal: abort.signal,
      apiKey: cfg.apiKey,
      sourceText: trimmed,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: cfg.translationModel,
      onFirstToken: () => {
        this.deps.tts.prewarm(args.targetLang);
      },
      // Stream text to the reader as it arrives — display never waits for a
      // sentence boundary (that's the unit for TTS, not for eyes).
      onDelta: (fullSoFar) => {
        if (turnId !== this.activeTurnId) return;
        const now = Date.now();
        if (now - lastDeltaWriteAt < DELTA_WRITE_THROTTLE_MS) return;
        lastDeltaWriteAt = now;
        store.updateTurn(turnId, { translatedText: fullSoFar.trim() });
      },
      onSentence: (sentence) => {
        if (turnId !== this.activeTurnId) return;
        if (this.state !== 'speaking') this.state = 'speaking';
        store.updateTurn(turnId, { stage: 'speaking' });
        this.ttsChunkPromises.push(
          this.deps.tts
            .speakChunk(sentence, args.targetLang)
            .then((outcome) => {
              if (outcome === 'no-voice') this.noteNoVoice(args.targetLang, listenerId);
            })
            .catch((err) => { console.warn('[Orchestrator] TTS chunk error:', err); }),
        );
      },
      onDone: (fullText) => {
        if (turnId !== this.activeTurnId) return;
        store.updateTurn(turnId, { translatedText: fullText.trim() });
      },
      onError: (err) => {
        translationFailed = true;
        this.failTurn(turnId, err.message);
      },
    });

    if (translationFailed) return;
    if (turnId !== this.activeTurnId) return;

    await Promise.all(this.ttsChunkPromises);
    if (turnId !== this.activeTurnId) return;

    await new Promise<void>((r) => setTimeout(r, 250));
    if (turnId !== this.activeTurnId) return;

    store.endTurn(turnId, { stage: 'done' });
    this.completeTurn(turnId);
  }

  /** Once-per-language "no voice installed" notice, on the listener's half —
   *  they're the one wondering why there is no audio. */
  private noteNoVoice(targetLang: string, listenerId: PersonId): void {
    const base = primarySubtag(targetLang);
    if (this.voiceNoticeShown.has(base)) return;
    this.voiceNoticeShown.add(base);
    log.warn(`[orch] no TTS voice for ${targetLang} — text only`);
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setNotice(listenerId, { key: 'noVoice', kind: 'info', lang: targetLang });
  }

  private failTurn(turnId: string, message: string): void {
    if (turnId !== this.activeTurnId) return;
    // The raw message goes to the log; the store gets a NoticeKey rendered in
    // the SPEAKER's language on their own half — they are the one person who
    // can act (press again, check Settings), and the old behavior handed the
    // raw English error to the listener instead.
    log.error(`[orch] turn failed: ${message}`);
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.endTurn(turnId, { stage: 'error', errorMessage: message });
    const key = classifyError(message);
    const speakerId = this.currentArgs?.speakerId;
    if (key && speakerId) {
      store.setNotice(speakerId, { key, kind: 'error' });
    }
    // A failed online request is the strongest offline signal we get —
    // re-probe now instead of waiting out the 30 s cadence.
    probeNetworkNow();
    try { this.translationAbort?.abort(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
    // Stop the mic so a subsequent enableHandsFree() can re-register the
    // dual-path callback. Without this, a Voxtral mid-turn error (onError path)
    // leaves streaming=true and the next startStreaming() is a no-op.
    void this.deps.audioCapture.stopStreaming().catch(() => {});
    this.completeTurn(turnId);
  }

  private completeTurn(turnId: string): void {
    if (turnId !== this.activeTurnId) return;
    this.state = 'idle';
    this.activeTurnId = null;
    this.currentArgs = null;
    this.ttsChunkPromises = [];
    this.translationAbort = null;
    const resolve = this.resolveTurnCompletion;
    this.resolveTurnCompletion = null;
    this.turnCompletionPromise = null;
    resolve?.();
  }
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** BCP-47 primary subtag — "es-MX" → "es", "EN" → "en". */
function primarySubtag(lang: string): string {
  const idx = lang.indexOf('-');
  return (idx === -1 ? lang : lang.slice(0, idx)).toLowerCase();
}
