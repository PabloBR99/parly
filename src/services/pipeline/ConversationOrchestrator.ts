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
//   flushUtterance() to get the transcript, route by the transcript's own
//   language (audio tag as fallback — see routeUtterance), and dispatch
//   through the existing Mistral → TTS pipeline.
//
//   Long utterances: streaming partials render live via the store's hfLive
//   field (side guessed from the text), the flush wait scales with how long
//   the person spoke, a flush timeout salvages the partial transcript
//   instead of dropping the utterance, and skipHfTurn() lets a reader cut a
//   long TTS readback short.
//
//   Ending a turn quickly (the two shortcuts, both evidence-gated):
//     · Early endpoint — the VAD's pause hint fires well before the hangover;
//       if the transcript has closed a sentence and stopped growing, the turn
//       ends there instead of waiting out silence it no longer needs.
//     · Settled transcript — the streamed partials are normally the whole
//       utterance by the time it ends, so the turn is dispatched from them
//       and the flush→final round trip is closed in the background rather
//       than waited on.
//   Both refuse unless the transcript alone routes the turn unambiguously:
//   skipping the final also skips the audio language tag, and a turn sent to
//   the wrong half is far worse than a slow one.
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
import { frameRms, publishAudioFrame, resetAudioLevel } from '../audio/audioLevelBus';
import { log } from '../log/logStore';
import { classifyError } from './errors';
import { classifyPairText } from './textLangId';
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
  /** Close the segment and take the transcript already streamed, without
   *  waiting for the server's final. */
  commitUtterance?(): { text: string; language?: string };
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
    /** Response headers arrived — the request is answered, the model is
     *  about to write. Splits connection/queue cost from generation cost. */
    onRequestOpen?: () => void;
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
  /** `onStart` fires when this chunk actually becomes audible. */
  speakChunk(
    text: string,
    language: string,
    onStart?: () => void,
  ): Promise<TTSSpeakOutcome>;
  stop(): void;
}

export interface VadLike {
  initialize(): Promise<void>;
  feedFrame(pcmInt16: Int16Array): void;
  subscribe(
    onSpeechStart: () => void,
    onSpeechEnd: (lastSpeechAt: number) => void,
    onSpeechPause?: (lastSpeechAt: number) => void,
  ): () => void;
  setActive(active: boolean): void;
  resetState(): void;
  /** Close the utterance without emitting an end event — the caller already
   *  took the turn from an `onSpeechPause`. */
  endUtterance?(): void;
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

/** How an HF utterance found its direction:
 *  'text' — transcript content decided (audio tag agreed or abstained);
 *  'text-override' — transcript contradicted and overrode the audio tag;
 *  'matched' — audio tag decided, transcript abstained;
 *  'fallback' — no evidence at all, speaker alternation. */
export type HfRoutingKind = 'matched' | 'text' | 'text-override' | 'fallback';

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
/** Base wait for a transcript final after flush/end. */
const FINAL_BASE_TIMEOUT_MS = 3_000;
/** Extra final-wait per ms of captured speech (¼×), and its cap. A fixed
 *  3 s was tuned for one-liners; a 40 s monologue has a longer transcription
 *  tail and deserves a longer leash before the salvage path kicks in. */
const FINAL_TIMEOUT_SLOPE = 0.25;
const FINAL_EXTRA_TIMEOUT_CAP_MS = 7_000;
/** Min interval between hfLive store writes from streaming partials. */
const HF_PARTIAL_WRITE_THROTTLE_MS = 150;

/**
 * How long the streaming transcript must go without growing before we treat
 * it as the whole utterance and stop waiting for the server's final.
 *
 * Voxtral buffers TARGET_STREAMING_DELAY_MS of audio before emitting; once
 * the room is silent, the deltas drain and stop. Silence in the transcript
 * for longer than one delivery gap therefore means the server has caught up
 * with the audio and there is nothing left to say — the final would repeat
 * the same sentence with tidier punctuation, several hundred milliseconds
 * later. This is the fast path's whole justification, so keep it comfortably
 * above the jitter between two consecutive deltas.
 */
const PARTIAL_SETTLED_MS = 140;
/** Below this, a "settled" transcript is more plausibly a cough or a stray
 *  syllable than a finished sentence. Let the server decide those. */
const FAST_PATH_MIN_CHARS = 4;
/** Sentence-final punctuation, tolerating a closing quote or bracket after
 *  it. Voxtral punctuates its transcripts, which makes this the one piece of
 *  linguistic evidence available that someone finished a thought — silence
 *  alone can never distinguish a full stop from drawing breath. */
const CLOSED_THOUGHT_RE = /[.!?…。！？؟।]["'”’»)\]]*$/;

/** What ended the utterance — 'punctuation' means the transcript closed a
 *  sentence during the pause hint, before the hangover expired. */
type HfEndpoint = 'silence' | 'punctuation';

/** Why a turn could not skip the server's final. Logged, because a shortcut
 *  that silently never fires looks exactly like a shortcut that does. */
type FastPathBlock = 'none' | 'no-transcript' | 'still-arriving' | 'routing-unclear';

/**
 * Cap on translation requests started speculatively per utterance. Each one
 * that misses is a wasted call against the user's own API key and rate limit,
 * so the budget is deliberately tiny: re-speculate once if the speaker adds
 * more after a long pause, then stop guessing and wait for the real ending.
 */
const MAX_SPECULATIONS_PER_UTTERANCE = 2;

/** Callbacks a real turn attaches to a translation already in flight. */
interface TranslationSink {
  onFirstToken: (at: number) => void;
  onDelta: (fullSoFar: string) => void;
  onSentence: (sentence: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

/**
 * A translation started before the turn it belongs to was certain.
 *
 * The request to Mistral is by far the longest link in the chain — far longer
 * than the silence the endpointer is still waiting out when this starts. So we
 * send it on the transcript we already have and let it run against the clock.
 * Nothing reaches the screen or the speaker until a real turn adopts it, and a
 * turn only adopts a speculation whose source text and direction match what
 * the utterance actually turned out to be. A miss costs one request; a hit
 * costs nothing and arrives sooner.
 */
interface SpeculativeTranslation {
  readonly sourceText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
  readonly abort: AbortController;
  readonly startedAt: number;
  firstTokenAt: number | null;
  openedAt: number | null;
  fullText: string;
  readonly sentences: string[];
  state: 'running' | 'done' | 'error';
  error: Error | null;
  /** Once a turn adopts it, callbacks stop buffering and go straight through. */
  sink: TranslationSink | null;
}

/**
 * Two transcripts are the same utterance if they carry the same words in the
 * same order. Punctuation, capitalisation and accents are exactly what the
 * server's final tends to tidy up, and none of them change the translation —
 * refusing to adopt over a comma would throw away the whole point. An added
 * or dropped word is a different sentence, and does not match.
 */
function sameUtterance(a: string, b: string): boolean {
  return foldForCompare(a) === foldForCompare(b);
}

function foldForCompare(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Final-transcript timeout scaled by how long the person actually spoke. */
function finalTimeoutFor(speechMs: number): number {
  return (
    FINAL_BASE_TIMEOUT_MS +
    Math.min(FINAL_EXTRA_TIMEOUT_CAP_MS, Math.round(speechMs * FINAL_TIMEOUT_SLOPE))
  );
}
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
  /** When the current HF utterance's capture began — scales the flush wait. */
  private hfCaptureStartAt: number | null = null;
  /** When the current PTT hold began — scales the final-transcript wait. */
  private pttRecordStartAt: number | null = null;
  /** Live-partial routing guess, sticky within one utterance. */
  private hfLiveSide: PersonId | null = null;
  private hfLastPartialWriteAt = 0;
  /** Latest streaming transcript for the utterance being captured, and when
   *  it last grew. Recorded on EVERY delta (the store write is throttled;
   *  this must not be, or a transcript still arriving looks settled). */
  private hfPartialText = '';
  private hfPartialAt = 0;
  /** Abort handle for the in-flight HF translation (skip / disable). */
  private hfTurnAbort: AbortController | null = null;
  /** Translation started ahead of the turn being certain — see the type. */
  private hfSpec: SpeculativeTranslation | null = null;
  private hfSpecCount = 0;
  /** The reader cut this HF turn short — end it quietly as done. */
  private hfSkipRequested = false;

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
    // The moment the phone takes the floor, the mic stops being a source of
    // truth about the room — drop the meter to silence rather than letting it
    // decay from whatever the last human syllable measured.
    if (next === 'hf-speaking') resetAudioLevel();
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
    this.pttRecordStartAt = Date.now();
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
    const heldMs = this.pttRecordStartAt !== null ? Date.now() - this.pttRecordStartAt : 0;
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
      // Long holds get a proportionally longer wait for the final before the
      // partial-salvage timeout: the tail of a monologue is the part the
      // speaker cared enough to keep talking for.
      await this.deps.voxtral.end(finalTimeoutFor(heldMs) + 2_000);
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
    this.hfPartialText = '';
    this.hfPartialAt = 0;
    resetAudioLevel();

    // Warm BOTH voices now. Which one the first turn needs isn't known until
    // somebody speaks, and by then the engine's cold-start sits directly in
    // front of the reply. Two warmups here cost nothing anyone is waiting on.
    this.deps.tts.prewarm(pairA);
    this.deps.tts.prewarm(pairB);
    // Same idea for the network: open the TLS session to Mistral now rather
    // than paying the handshake inside the first turn's translation request.
    // The app-launch prewarm is minutes stale by the time hands-free starts.
    void this.deps.translator
      .prewarm({ apiKey: cfg.apiKey, model: cfg.translationModel })
      .catch(() => { /* best-effort */ });

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
      (lastSpeechAt) => void this.handleHfSpeechEnd(lastSpeechAt),
      (lastSpeechAt) => this.handleHfSpeechPause(lastSpeechAt),
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
    store.setHfLive(null);

    // Abort any translation still streaming for an HF turn — its onSentence
    // gate would abort eventually, but doing it here is immediate.
    this.hfSkipRequested = true;
    try { this.hfTurnAbort?.abort(); } catch { /* noop */ }
    this.hfTurnAbort = null;
    this.cancelSpeculation();

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
    resetAudioLevel();

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
    this.cancelSpeculation();
    resetAudioLevel();
    (this.deps.conversationStore ?? useConversationStore).getState().setHfLive(null);
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
    // One question decides both consumers: is this the room talking, or the
    // phone hearing itself? Only the room may reach the transcriber, and only
    // the room may drive the seam wave.
    const fromTheRoom = this.hfState !== 'hf-speaking' && this.hfState !== 'hf-cooldown';
    if (fromTheRoom) {
      this.deps.voxtral.feedAudio(base64Pcm);
    }
    this.feedAudioToVad(base64Pcm, fromTheRoom);
  };

  private handleHfSpeechStart(): void {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-idle') return;
    log.info('[orch/hf] speech_start → capturing');
    this.hfCaptureStartAt = Date.now();
    this.hfLiveSide = null;
    this.hfPartialText = '';
    this.hfPartialAt = 0;
    this.hfSpecCount = 0;
    this.cancelSpeculation();
    this.setHfState('hf-capturing');
  }

  /** Drop any translation started ahead of a turn. Safe to call at any time. */
  private cancelSpeculation(): void {
    const spec = this.hfSpec;
    this.hfSpec = null;
    if (!spec) return;
    try { spec.abort.abort(); } catch { /* noop */ }
  }

  /**
   * Send the translation now, on the transcript we already have, without
   * waiting for the turn to be certain. See SpeculativeTranslation.
   *
   * Routing here may lean on weak evidence, unlike the commit shortcuts: this
   * decision is reversible. If the utterance turns out to travel the other
   * way, or to say something else, the result is discarded unread.
   */
  private startSpeculativeTranslation(text: string): void {
    const cfg = this.config;
    if (!cfg) return;
    if (this.hfSpec !== null && sameUtterance(this.hfSpec.sourceText, text)) return;
    if (this.hfSpecCount >= MAX_SPECULATIONS_PER_UTTERANCE) return;

    // Speaker alternation is not evidence about THIS utterance, and the turn
    // it would guess can change before the ending arrives. Never speculate on it.
    const routing = this.routeUtterance(null, text);
    if (!routing || routing.kind === 'fallback') return;

    this.cancelSpeculation();
    this.hfSpecCount++;

    const spec: SpeculativeTranslation = {
      sourceText: text,
      sourceLang: routing.sourceLang,
      targetLang: routing.targetLang,
      abort: new AbortController(),
      startedAt: Date.now(),
      firstTokenAt: null,
      openedAt: null,
      fullText: '',
      sentences: [],
      state: 'running',
      error: null,
      sink: null,
    };
    this.hfSpec = spec;
    log.info(`[orch/hf] translating ahead of the ending (${routing.sourceLang}→${routing.targetLang})`);

    // The target voice is knowable now too — warm it while the request flies.
    this.deps.tts.prewarm(routing.targetLang);

    void this.deps.translator
      .translateStream({
        signal: spec.abort.signal,
        apiKey: cfg.apiKey,
        sourceText: text,
        sourceLang: routing.sourceLang,
        targetLang: routing.targetLang,
        model: cfg.translationModel,
        onRequestOpen: () => {
          if (spec.openedAt === null) spec.openedAt = Date.now();
        },
        onFirstToken: () => {
          if (spec.firstTokenAt === null) spec.firstTokenAt = Date.now();
          spec.sink?.onFirstToken(spec.firstTokenAt);
        },
        onDelta: (fullSoFar) => {
          spec.fullText = fullSoFar;
          spec.sink?.onDelta(fullSoFar);
        },
        onSentence: (sentence) => {
          if (spec.sink) spec.sink.onSentence(sentence);
          else spec.sentences.push(sentence);
        },
        onDone: (fullText) => {
          spec.fullText = fullText;
          spec.state = 'done';
          spec.sink?.onDone(fullText);
        },
        onError: (err) => {
          spec.state = 'error';
          spec.error = err;
          spec.sink?.onError(err);
        },
      })
      .catch(() => {
        spec.state = 'error';
      });
  }

  /**
   * Hand a speculation's stream to the turn that adopted it: replay whatever
   * already arrived, then let the rest flow straight through. Resolves when
   * the stream ends, so callers can await it exactly like a fresh one.
   */
  private adoptSpeculation(
    spec: SpeculativeTranslation,
    sink: TranslationSink,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        resolve();
      };
      spec.sink = {
        onFirstToken: sink.onFirstToken,
        onDelta: sink.onDelta,
        onSentence: sink.onSentence,
        onDone: (fullText) => { sink.onDone(fullText); finish(); },
        onError: (err) => { sink.onError(err); finish(); },
      };

      // Replay what landed before this turn existed to receive it.
      if (spec.firstTokenAt !== null) sink.onFirstToken(spec.firstTokenAt);
      if (spec.fullText.length > 0) sink.onDelta(spec.fullText);
      const buffered = spec.sentences.splice(0, spec.sentences.length);
      for (const sentence of buffered) sink.onSentence(sentence);

      if (spec.state === 'done') { sink.onDone(spec.fullText); finish(); }
      else if (spec.state === 'error') {
        sink.onError(spec.error ?? new Error('Translation failed'));
        finish();
      }
    });
  }

  /**
   * The transcript, if it is safe to translate without the server's final:
   * long enough to be a sentence, no longer growing, and unambiguous about
   * which direction it should travel.
   *
   * That last condition is not fussiness. Skipping the final also skips the
   * audio language tag that comes with it, so the fast path only exists where
   * the text alone decides the routing outright. Anything the classifier is
   * merely leaning towards goes the slow way and keeps its second opinion.
   */
  private settledTranscript(now: number): string | null {
    return this.inspectTranscript(now).text;
  }

  /** The settled transcript, or why there isn't one. */
  private inspectTranscript(now: number): { text: string | null; blocked: FastPathBlock } {
    const text = this.hfPartialText;
    if (text.length < FAST_PATH_MIN_CHARS) return { text: null, blocked: 'no-transcript' };
    if (now - this.hfPartialAt < PARTIAL_SETTLED_MS) {
      return { text: null, blocked: 'still-arriving' };
    }
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!pairA || !pairB) return { text: null, blocked: 'routing-unclear' };
    const a = primarySubtag(pairA);
    const b = primarySubtag(pairB);
    if (a === b) return { text: null, blocked: 'routing-unclear' };
    if (classifyPairText(text, a, b)?.strength !== 'strong') {
      return { text: null, blocked: 'routing-unclear' };
    }
    return { text, blocked: 'none' };
  }

  /**
   * Early endpoint. The VAD noticed a short silence — not enough on its own
   * to call the turn over — but if the transcript has already closed a
   * sentence and stopped growing, the speaker is finished and the rest of the
   * hangover is dead air in front of the reply. Anything less certain waits.
   */
  private handleHfSpeechPause(lastSpeechAt: number): void {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-capturing') return;
    const now = Date.now();

    // Whatever happens to the turn, the translation can start now. It is the
    // longest link in the chain by a wide margin, so the silence still being
    // waited out below is time it can spend in flight instead.
    const stable = this.hfPartialText;
    if (stable.length >= FAST_PATH_MIN_CHARS && now - this.hfPartialAt >= PARTIAL_SETTLED_MS) {
      this.startSpeculativeTranslation(stable);
    }

    if (!this.deps.voxtral.commitUtterance) return;
    const settled = this.settledTranscript(now);
    if (settled === null || !CLOSED_THOUGHT_RE.test(settled)) return;
    log.info('[orch/hf] early endpoint — transcript closed a sentence');
    // Cancel the hangover that would otherwise deliver a second ending.
    this.deps.vad?.endUtterance?.();
    void this.handleHfSpeechEnd(lastSpeechAt, 'punctuation');
  }

  private async handleHfSpeechEnd(
    lastSpeechAt?: number,
    endpoint: HfEndpoint = 'silence',
  ): Promise<void> {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-capturing') return;
    if (!this.deps.voxtral.flushUtterance) return;

    const vadEndAt = Date.now();
    // When the room actually went quiet — not when the hangover expired.
    // Every latency number below is measured from here, because this is where
    // the person starts waiting.
    const speechEndAt = lastSpeechAt ?? vadEndAt;
    const capturedMs = this.hfCaptureStartAt !== null ? vadEndAt - this.hfCaptureStartAt : 0;
    log.info(`[orch/hf] speech_end (${endpoint}) → flushing (captured ${capturedMs} ms)`);
    this.setHfState('hf-flushing');

    const store0 = (this.deps.conversationStore ?? useConversationStore).getState();
    const commit = this.deps.voxtral.commitUtterance;
    const inspected = this.inspectTranscript(vadEndAt);
    const settled = commit ? inspected.text : null;
    const fastPathBlock: FastPathBlock = commit ? inspected.blocked : 'no-transcript';

    let result: { text: string; language?: string };
    const flushSentAt = Date.now();
    if (settled !== null && commit) {
      // The transcript is in hand and has stopped moving. Close the segment
      // and go — waiting out the round trip here buys punctuation, and costs
      // the listener the pause they notice most.
      const taken = commit.call(this.deps.voxtral);
      result = { text: taken.text.trim() || settled, language: taken.language };
    } else {
      try {
        result = await this.deps.voxtral.flushUtterance(finalTimeoutFor(capturedMs));
      } catch (e) {
        log.error('[orch/hf] flushUtterance failed', e instanceof Error ? e : new Error(String(e)));
        store0.setHfLive(null);
        if (this.hfEnabled) {
          this.setHfState('hf-idle');
          await this.attemptHfReconnect();
        }
        return;
      }
    }
    const flushedAt = Date.now();

    // The live partial's job ends where the routed turn begins.
    store0.setHfLive(null);

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
      speechEndAt,
      vadEndAt,
      flushSentAt,
      flushedAt,
      endpoint,
      transcriptSource: settled !== null ? 'settled-partial' : 'server-final',
      fastPathBlock,
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
    kind: HfRoutingKind;
  } | null {
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!pairA || !pairB) return null;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();

    // Compare BCP-47 primary subtags so "es-MX" matches "es" symmetrically
    // and a regional pair like (es, es-MX) doesn't always route to A.
    const a = primarySubtag(pairA);
    const b = primarySubtag(pairB);

    if (a !== b) {
      const dl = detectedLang ? primarySubtag(detectedLang) : null;
      const audioVote: 'a' | 'b' | null = dl === a ? 'a' : dl === b ? 'b' : null;

      // The transcript is stronger routing evidence than the audio tag: it is
      // the very text about to be translated, so ITS language decides which
      // direction produces a real translation. The audio tag misfires often
      // enough (Spanish tagged en, Catalan for Spanish, or missing entirely)
      // that trusting it alone made HF "translate" Spanish into Spanish and
      // parrot the speaker. Strong text evidence overrides a contradicting
      // tag; weak evidence only fills in when the tag abstained — and both
      // beat blind speaker alternation.
      const textVote = classifyPairText(text, a, b);
      const textSide =
        textVote && (textVote.strength === 'strong' || audioVote === null)
          ? textVote.side
          : null;
      const side = textSide ?? audioVote;

      if (side) {
        const kind: HfRoutingKind = textSide
          ? audioVote && audioVote !== textSide
            ? 'text-override'
            : 'text'
          : 'matched';
        if (kind === 'text-override') {
          log.warn(
            `[orch/hf] transcript overrides audio tag lang=${detectedLang} → ${side === 'a' ? a : b} text="${text.slice(0, 30)}"`,
          );
        }
        return side === 'a'
          ? { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind }
          : { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind };
      }

      if (detectedLang) {
        // Audio says a language outside the pair AND the transcript claims
        // neither side — discard with visual feedback on the side whose turn
        // it likely was (alternate from last routed).
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

    // No usable evidence (or ambiguous same-subtag pair) — alternate from
    // last routed turn. First turn defaults to person_a.
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
      speechEndAt: number;
      vadEndAt: number;
      flushSentAt: number;
      flushedAt: number;
      endpoint: HfEndpoint;
      transcriptSource: 'settled-partial' | 'server-final';
      fastPathBlock: FastPathBlock;
      routedLanguage: string | null;
      configuredPair: [string, string];
      routingResult: HfRoutingKind;
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

    // A translation may already be in flight from the pause hint. Adopt it
    // only if it is a translation of THIS utterance, in THIS direction —
    // otherwise it is a guess that missed, and it is discarded unread.
    const spec = this.hfSpec;
    this.hfSpec = null;
    const adopted =
      spec !== null &&
      spec.state !== 'error' &&
      spec.sourceLang === sourceLang &&
      spec.targetLang === targetLang &&
      sameUtterance(spec.sourceText, sourceText)
        ? spec
        : null;
    if (spec !== null && adopted === null) {
      log.info('[orch/hf] speculative translation discarded — the utterance changed');
      try { spec.abort.abort(); } catch { /* noop */ }
    }

    const abort = adopted?.abort ?? new AbortController();
    this.hfTurnAbort = abort;
    this.hfSkipRequested = false;
    const listenerId: PersonId = speakerId === 'person_a' ? 'person_b' : 'person_a';
    const ttsPromises: Promise<void>[] = [];
    let firstTokenAt: number | null = null;
    let requestOpenAt: number | null = null;
    let firstTtsStartAt: number | null = null;
    let firstAudioAt: number | null = null;
    let lastDeltaWriteAt = 0;

    const sink: TranslationSink = {
      onFirstToken: (at) => {
        if (firstTokenAt === null) firstTokenAt = at;
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
            .speakChunk(sentence, targetLang, () => {
              if (firstAudioAt === null) firstAudioAt = Date.now();
            })
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
        // A reader-initiated skip aborts the stream mid-flight — that is the
        // turn ending as intended, not an error to alarm anyone with.
        if (this.hfSkipRequested) return;
        log.error('[orch/hf] translation error', err);
        store.endTurn(id, { stage: 'error', errorMessage: err.message });
        const key = classifyError(err.message);
        if (key) store.setNotice(speakerId, { key, kind: 'error' });
        probeNetworkNow();
      },
    };

    if (adopted !== null) {
      requestOpenAt = adopted.openedAt;
      await this.adoptSpeculation(adopted, sink);
    } else {
      await this.deps.translator.translateStream({
        signal: abort.signal,
        apiKey: cfg.apiKey,
        sourceText,
        sourceLang,
        targetLang,
        model: cfg.translationModel,
        onRequestOpen: () => {
          if (requestOpenAt === null) requestOpenAt = Date.now();
        },
        onFirstToken: () => sink.onFirstToken(Date.now()),
        onDelta: sink.onDelta,
        onSentence: sink.onSentence,
        onDone: sink.onDone,
        onError: sink.onError,
      });
    }

    await Promise.all(ttsPromises);
    this.hfTurnAbort = null;
    const endAt = Date.now();

    if (store.turns.find(t => t.id === id)?.stage !== 'error') {
      store.endTurn(id, { stage: 'done' });
    }

    // Structured HF turn telemetry. One emit per turn, and the only place the
    // latency budget is written down: every field is a segment of the wait
    // between someone finishing a sentence and hearing it come back, so the
    // parts add up and the biggest one is always obvious.
    const finalAt = telemetry.flushedAt;
    const since = (t: number | null): number =>
      t !== null ? t - telemetry.speechEndAt : -1;
    const payload = {
      kind: 'hf_turn' as const,
      endpoint: telemetry.endpoint,
      transcript: telemetry.transcriptSource,
      fastPathBlock: telemetry.fastPathBlock,
      translation: adopted !== null ? 'speculative' : 'fresh',
      // How much of the request flew before the turn was even certain.
      translationLead: adopted !== null ? finalAt - adopted.startedAt : 0,
      // The number that matters: silence → first audible word.
      speechEndToAudio: since(firstAudioAt),
      endpointDelay: telemetry.vadEndAt - telemetry.speechEndAt,
      vadEndToFlush: telemetry.flushSentAt - telemetry.vadEndAt,
      flushToFinal: finalAt - telemetry.flushSentAt,
      finalToFirstToken: firstTokenAt !== null ? firstTokenAt - finalAt : -1,
      // The two halves of the request's own cost: getting answered (connection,
      // queue, prefill) versus the model writing. They need different fixes.
      requestToOpen:
        requestOpenAt !== null
          ? requestOpenAt - (adopted?.startedAt ?? telemetry.flushedAt)
          : -1,
      openToFirstToken:
        requestOpenAt !== null && firstTokenAt !== null ? firstTokenAt - requestOpenAt : -1,
      firstTokenToFirstTtsStart:
        firstTokenAt !== null && firstTtsStartAt !== null
          ? firstTtsStartAt - firstTokenAt
          : -1,
      ttsQueueToAudio:
        firstTtsStartAt !== null && firstAudioAt !== null
          ? firstAudioAt - firstTtsStartAt
          : -1,
      totalTurnDuration: endAt - telemetry.speechEndAt,
      routedLanguage: telemetry.routedLanguage,
      configuredPair: telemetry.configuredPair,
      routingResult: telemetry.routingResult,
      utteranceWordCount: sourceText.split(/\s+/).filter(Boolean).length,
    };
    log.info(`[hf_turn] ${JSON.stringify(payload)}`);
  }

  /**
   * Streaming HF partials → the transient `hfLive` store field (never a
   * turn: turns don't exist until the utterance is flushed and routed).
   * The side is the text classifier's live guess so the words appear on the
   * SPEAKER's own half; a guess is sticky for the rest of the utterance so
   * the caption doesn't hop across the seam mid-sentence. Until there is
   * enough text to call a side, nothing renders — a caption on the wrong
   * half is worse than a beat of silence.
   */
  private handleHfPartial(text: string): void {
    if (!this.hfEnabled || this.hfPaused) return;
    if (this.hfState !== 'hf-capturing' && this.hfState !== 'hf-flushing') return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const now = Date.now();
    // Record every delta. The store write below is throttled because the
    // screen cannot use 30 updates a second, but the endpoint decision is
    // precisely a question about WHEN the transcript last grew — sampled
    // through a throttle, a sentence still arriving would look finished.
    this.hfPartialText = trimmed;
    this.hfPartialAt = now;
    if (now - this.hfLastPartialWriteAt < HF_PARTIAL_WRITE_THROTTLE_MS) return;
    this.hfLastPartialWriteAt = now;

    if (this.hfLiveSide === null && this.hfPairA && this.hfPairB) {
      const a = primarySubtag(this.hfPairA);
      const b = primarySubtag(this.hfPairB);
      if (a !== b) {
        const vote = classifyPairText(trimmed, a, b);
        if (vote) this.hfLiveSide = vote.side === 'a' ? 'person_a' : 'person_b';
      }
    }
    (this.deps.conversationStore ?? useConversationStore)
      .getState()
      .setHfLive({ side: this.hfLiveSide, text: trimmed });
  }

  /**
   * Cut the in-flight HF turn short — the reader tapped the streaming
   * translation. Stops TTS, aborts the translation stream, and lets the
   * turn end quietly as 'done' with whatever text already arrived; the
   * machine then proceeds to cooldown and listens again. This is the door
   * out of a long readback nobody needs spoken to the end.
   */
  skipHfTurn(): void {
    if (!this.hfEnabled) return;
    if (this.hfState !== 'hf-routing' && this.hfState !== 'hf-speaking') return;
    log.info('[orch/hf] turn skipped by reader — stopping TTS');
    this.hfSkipRequested = true;
    try { this.hfTurnAbort?.abort(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
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
    this.cancelSpeculation();
    (this.deps.conversationStore ?? useConversationStore).getState().setHfLive(null);
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

  /**
   * Decode one capture chunk and drain it into the VAD as 512-sample frames.
   *
   * `fromTheRoom` also gates the audio-level meter: the same frames that feed
   * turn detection carry the loudness that drives the seam wave, so the level
   * is published here rather than in a second decode pass. Frame cadence IS
   * meter cadence — 32 ms, ~31 updates/s, which is what makes the wave track
   * a voice instead of lagging behind it.
   */
  private feedAudioToVad(base64Pcm: string, fromTheRoom: boolean): void {
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
      if (fromTheRoom) publishAudioFrame(frameRms(frame));
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
