// ConversationOrchestrator — the per-turn state machine.
//
// Push-to-talk: hold → capture → Voxtral streams partials → release → final →
// Mistral SSE → TTS per sentence → turn done.
//
// Hands-free: one Voxtral session stays open across utterances, Silero VAD
// marks their edges, and each transcript is routed by its own language.
//   hf-idle → hf-capturing → hf-flushing → hf-routing → hf-speaking
//           ↑                                        └──► hf-cooldown ──┘
//   (lang ∉ pair → discarded, straight back to hf-idle)
//
// Three questions, each asked in exactly one place: is the speaker finished
// (`evaluateEndpoint`), what did they say (`takeTurn`), which way does it
// travel (`routeUtterance`). The shortcut past the server's final refuses
// unless the transcript alone routes the turn — skipping the final also skips
// its audio language tag, and a turn sent to the wrong half beats a slow one.
//
// Everything about the current speaker lives on one `Utterance`, so async work
// closes over the utterance it belongs to: a late answer finds an object
// nothing points at and stops. No sequence numbers, no fields to remember to
// reset. Every collaborator is an interface — this is the most error-prone
// component and must be testable without WebSockets, fetch or Android TTS.

import { useConversationStore } from '../../store/conversationStore';
import type { HfActivity } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { frameRms, publishAudioFrame, resetAudioLevel } from '../audio/audioLevelBus';
import { decodePcm16, encodePcm16 } from '../audio/pcm';
import { errorMessage, toError } from '../../app/errors';
import { SpeechAgc } from '../audio/SpeechAgc';
import { log } from '../log/logStore';
import type { SegmentClose } from '../stt/VoxtralRealtimeClient';
import { buildNameIndex, repairNames, type NameIndex } from '../stt/nameRepair';
import { commonNamesFor } from '../../app/names';
import { classifyError } from './errors';
import { classifyPairText, writtenInScriptOf } from './textLangId';
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
    options: {
      apiKey: string;
      model?: string;
      sessionMode?: boolean;
      targetStreamingDelayMs?: number;
    },
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
  /** End the current speech segment. Answers with the text already streamed
   *  AND a promise of the server's own transcript — see SegmentClose. */
  closeSegment?(timeoutMs?: number): SegmentClose;
  endSession?(): Promise<void>;
  /** Drop text accumulated since the last segment (TTS echo scrubbing). */
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
    /** What the interpreter knows besides this sentence — see
     *  MistralTranslator's TranslationContext. */
    context?: {
      names?: readonly string[];
      history?: readonly { source: string; translation: string }[];
    };
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
  /** Select a voice without speaking a primer — safe to do between turns. */
  presetVoice(language: string): void;
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
    onSpeechResume?: () => void,
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

/** Which half is speaking, and the direction their words travel. */
interface Direction {
  speakerId: PersonId;
  sourceLang: string;
  targetLang: string;
}

/** A direction, plus what decided it. */
interface Routing extends Direction {
  kind: HfRoutingKind;
}

export interface BeginTurnArgs {
  readonly speakerId: PersonId;
  readonly sourceLang: string;
  readonly targetLang: string;
}

export interface OrchestratorConfig {
  readonly apiKey: string;
  readonly translationModel: string;
  readonly sttModel?: string;
  /** Right context Voxtral buffers before committing words. Omitted means the
   *  client's own default (accurate). */
  readonly sttStreamingDelayMs?: number;
  /** The people in this conversation — repaired towards in the transcript and
   *  given to the translator as a glossary. */
  readonly people?: readonly string[];
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
/** Exchanges handed to the translator as context. Enough to resolve what the
 *  new sentence refers to; not so many that prefill grows for nothing. */
const HISTORY_TURNS_AS_CONTEXT = 3;

/** How long the transcript must go without growing before we treat it as the
 *  whole utterance. Longer than one delta gap means the server has caught up
 *  with the audio, so its final would only re-punctuate the same sentence a
 *  few hundred ms later. Keep comfortably above inter-delta jitter. */
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

/** Speculative translations per utterance. Each miss is a wasted call against
 *  the user's own key, so: guess again once if the speaker resumes, then wait
 *  for the real ending. */
const MAX_SPECULATIONS_PER_UTTERANCE = 2;

/** Whether the turn used a transcript an early close had already delivered
 *  ('used'), one sent but unanswered in time ('empty'), or no early close. */
type EarlyCloseOutcome = 'used' | 'empty' | 'none';

/**
 * Untagged utterances before the shortcuts stop demanding strong text evidence.
 *
 * Strictness exists to protect a second opinion: skipping the final also skips
 * its `transcription.language`, which might have overruled a weak text vote.
 * But measured on device Voxtral often sends no tag at all, and then the gate
 * guards a fallback that never arrives and refuses every shortcut for nothing.
 * After this many silent turns a weak vote is accepted — it is what routing
 * falls back to anyway. One tag arriving restores strictness immediately.
 */
const UNTAGGED_UTTERANCES_TO_TRUST_TEXT = 2;

/** Callbacks a real turn attaches to a translation already in flight. */
interface TranslationSink {
  onFirstToken: (at: number) => void;
  onDelta: (fullSoFar: string) => void;
  onSentence: (sentence: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

/**
 * One translation request, from sent to last sentence spoken.
 *
 * Exactly one per turn, whether it was started early on a guess or by the turn
 * itself — a speculative path beside a normal one would be two of everything
 * with only the easy one tested. Here "normal" is just a run whose buffer is
 * empty when the turn attaches.
 *
 * Nothing reaches screen or speaker until a turn attaches, and only to a run
 * whose text and direction match what the utterance turned out to be. A miss
 * costs one request; a hit starts several hundred ms early.
 */
class TranslationRun {
  readonly abort = new AbortController();
  readonly startedAt = Date.now();
  firstTokenAt: number | null = null;
  openedAt: number | null = null;
  fullText = '';

  private state: 'running' | 'done' | 'error' = 'running';
  private error: Error | null = null;
  private readonly buffered: string[] = [];
  private sink: TranslationSink | null = null;
  private finish: (() => void) | null = null;
  private settleWaiters: Array<() => void> = [];

  constructor(
    readonly sourceText: string,
    readonly sourceLang: string,
    readonly targetLang: string,
  ) {}

  /** Whether this run is a translation of THIS utterance, in THIS direction. */
  answers(sourceText: string, sourceLang: string, targetLang: string): boolean {
    return (
      this.state !== 'error' &&
      this.sourceLang === sourceLang &&
      this.targetLang === targetLang &&
      sameUtterance(this.sourceText, sourceText)
    );
  }

  // ── The producer side: what the translator reports ──────────────────────
  noteOpen(at: number): void {
    if (this.openedAt === null) this.openedAt = at;
  }
  noteFirstToken(at: number): void {
    if (this.firstTokenAt === null) this.firstTokenAt = at;
    this.sink?.onFirstToken(this.firstTokenAt);
  }
  noteDelta(fullSoFar: string): void {
    this.fullText = fullSoFar;
    this.sink?.onDelta(fullSoFar);
  }
  noteSentence(sentence: string): void {
    if (this.sink) this.sink.onSentence(sentence);
    else this.buffered.push(sentence);
  }
  noteDone(fullText: string): void {
    this.fullText = fullText;
    this.state = 'done';
    this.sink?.onDone(fullText);
    this.finish?.();
    this.markSettled();
  }
  noteError(err: Error): void {
    this.state = 'error';
    this.error = err;
    this.sink?.onError(err);
    this.finish?.();
    this.markSettled();
  }

  private markSettled(): void {
    for (const w of this.settleWaiters.splice(0, this.settleWaiters.length)) w();
  }

  /** Resolves when the stream has ended, whether or not a turn is listening.
   *  Lets a caller read the result before deciding to show it to anyone. */
  settled(): Promise<void> {
    if (this.state !== 'running') return Promise.resolve();
    return new Promise<void>((resolve) => { this.settleWaiters.push(resolve); });
  }

  /**
   * The model handed back its own input — what asking in the wrong direction
   * looks like from outside: the app parrots the speaker. Folded comparison,
   * because a parrot that capitalises is still a parrot. Some words genuinely
   * survive translation ("Madrid", "OK"), so this is evidence and not proof —
   * the caller tries the other direction before believing it.
   */
  returnedItsInput(sourceText: string): boolean {
    return this.fullText.trim().length > 0 && sameUtterance(this.fullText, sourceText);
  }

  /**
   * Hand the stream to the turn that took it: replay whatever already arrived,
   * then let the rest flow straight through. Resolves when the stream ends, so
   * a turn awaits this identically whether the request flew early or was sent
   * a millisecond ago.
   */
  attach(sink: TranslationSink): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        resolve();
      };
      this.finish = finish;
      this.sink = sink;

      // Replay what landed before this turn existed to receive it.
      if (this.firstTokenAt !== null) sink.onFirstToken(this.firstTokenAt);
      if (this.fullText.length > 0) sink.onDelta(this.fullText);
      for (const sentence of this.buffered.splice(0, this.buffered.length)) {
        sink.onSentence(sentence);
      }

      if (this.state === 'done') { sink.onDone(this.fullText); finish(); }
      else if (this.state === 'error') {
        sink.onError(this.error ?? new Error('Translation failed'));
        finish();
      }
    });
  }
}

/**
 * One person speaking, from the VAD's speech_start until the turn is taken.
 *
 * Async work — a segment close, a settle timer, a speculative translation —
 * closes over the utterance it belongs to, so a late answer finds an object
 * that has `ended` and stops. The next utterance is a new object and this one
 * is inert: no sequence numbers, no list of fields to reset. It also makes
 * "the speaker was not finished" expressible in one place (`resumeSpeaking`).
 */
class Utterance {
  readonly startedAt = Date.now();
  /** The turn has been taken. Nothing may write to this utterance again. */
  ended = false;

  /** Transcripts of segments already closed for this utterance. */
  private head = '';
  /** The segment still open, as the server has streamed it, and when it grew. */
  private tail = '';
  private tailAt = 0;
  /** Language tag from the most recent closed segment. */
  language: string | undefined;

  /** Live-partial routing guess, sticky for the whole utterance so the caption
   *  does not hop across the seam mid-sentence. */
  side: PersonId | null = null;

  /** A segment close whose answer has not arrived yet. Non-null means one is
   *  already in the air, which is the only reason to not open another. */
  closing: SegmentClose | null = null;
  /** Whether THIS pause has already closed a segment. Distinct from `closing`,
   *  which clears the moment the answer lands: without this, a delta arriving
   *  after the answer would re-arm the settle check and close a second time
   *  inside the same silence. */
  closedThisPause = false;
  /** Duration of the pause-hint round trip, for telemetry. */
  closingMs = -1;
  /** Whether any segment was closed before the utterance ended. */
  closedEarly = false;

  /** The translation, once there is one — see TranslationRun. */
  run: TranslationRun | null = null;
  runCount = 0;

  /** When the room went quiet, while a pause hint is outstanding. */
  pauseHintAt: number | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Names are put right on the way IN. Four things read this transcript — the
   *  caption, the router, the speculation and the turn — and repairing at only
   *  some of them would make them disagree about what was said, so a
   *  speculation sent on "Sisi" could never be adopted by a turn that settled
   *  on "Cycy". */
  constructor(private readonly repair: (text: string) => string = (t) => t) {}

  /** Everything said so far: closed segments plus whatever has streamed since. */
  text(): string {
    return joinUtterance(this.head, this.tail);
  }

  /** A delta arrived for the open segment. */
  noteDelta(text: string, at: number): void {
    this.tail = this.repair(text);
    this.tailAt = at;
  }

  /** The tag the server reported for this utterance, if it reported one. It
   *  arrives with a closing segment, which is not always waited for — so it is
   *  taken the moment the segment closes rather than only from the answer. */
  noteLanguage(language: string | undefined): void {
    if (language) this.language = language;
  }

  /** Fold in the transcript of a segment that has just closed. */
  absorbSegment(text: string, language: string | undefined): void {
    const trimmed = this.repair(text).trim();
    if (trimmed.length > 0) {
      this.head = joinUtterance(this.head, trimmed);
      // The segment's transcript covers every delta it streamed; keeping both
      // would put the same words in the utterance twice.
      this.tail = '';
      this.tailAt = 0;
    }
    if (language) this.language = language;
  }

  /**
   * Whether the transcript has stopped arriving. Only a streaming tail can be
   * half-delivered — a closed segment's transcript is complete by construction,
   * so an utterance made of nothing but those never waits.
   */
  settled(now: number): boolean {
    return this.tail.length === 0 || now - this.tailAt >= PARTIAL_SETTLED_MS;
  }

  /** Arm `onSettled` to fire once the transcript has been quiet long enough,
   *  re-arming if it is already armed. Re-arming must not disturb the hint
   *  itself — that is what the check is waiting to answer. */
  armSettleCheck(onSettled: () => void): void {
    if (this.pauseHintAt === null) return;
    this.clearSettleTimer();
    const quietFor = Date.now() - this.tailAt;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      onSettled();
    }, Math.max(0, PARTIAL_SETTLED_MS - quietFor));
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  /** Forget the pause hint and the check it armed. */
  private forgetPauseHint(): void {
    this.pauseHintAt = null;
    this.closedThisPause = false;
    this.clearSettleTimer();
  }

  /** Drop a translation started ahead of the turn. Safe to call at any time. */
  cancelRun(): void {
    const run = this.run;
    this.run = null;
    if (run) {
      try { run.abort.abort(); } catch { /* noop */ }
    }
  }

  /** The speaker was not finished — undo what the pause hint set in motion. A
   *  segment already closed stays closed (its words are in `head`), and a close
   *  still in flight stays too, because it will answer for those words. */
  resumeSpeaking(): void {
    this.forgetPauseHint();
    this.cancelRun();
  }

  /** Nothing may write to this utterance again. */
  end(): void {
    this.ended = true;
    this.forgetPauseHint();
  }
}

/** Same words in the same order. Punctuation, case and accents are what the
 *  server's final tidies up and none of them change the translation, so
 *  refusing to adopt over a comma would throw away the point. An added or
 *  dropped word is a different sentence. */
function sameUtterance(a: string, b: string): boolean {
  return foldForCompare(a) === foldForCompare(b);
}

/** Stitch a segment an early flush closed onto the words spoken after it.
 *  Either side may be empty, which is the common case both ways. */
function joinUtterance(head: string, tail: string): string {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  return `${head} ${tail}`;
}

/** The other language of the configured pair — the one a reply will be spoken
 *  in. Null when `lang` isn't in the pair at all, which means we don't know
 *  what comes next and should not guess. */
function otherOfPair(lang: string, a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const base = primarySubtag(lang);
  if (base === primarySubtag(a)) return b;
  if (base === primarySubtag(b)) return a;
  return null;
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
  /** Level normalisation in front of the transcriber only — see SpeechAgc. */
  private readonly agc = new SpeechAgc();
  /** Name index, rebuilt only when the glossary or the pair changes. */
  private nameIndex: NameIndex | null = null;
  private nameIndexKey = '';
  /** Names put right in the transcript since the last turn was dispatched,
   *  for the telemetry line — a repair nobody can see is a repair nobody can
   *  check. */
  private repairsThisTurn: string[] = [];
  /** When the current PTT hold began — scales the final-transcript wait. */
  private pttRecordStartAt: number | null = null;
  private hfLastPartialWriteAt = 0;
  /** The person currently speaking, and everything about what they are saying.
   *  Null between utterances. Replaced — never patched — on each speech start,
   *  which is what makes a late answer to the previous one inert. */
  private hfUtterance: Utterance | null = null;
  /** Abort handle for the in-flight HF translation (skip / disable). */
  private hfTurnAbort: AbortController | null = null;
  /** Consecutive utterances whose transcript carried no audio language tag. */
  private hfUntaggedStreak = 0;
  /** The reader cut this HF turn short — end it quietly as done. */
  private hfSkipRequested = false;

  /** The conversation store, resolved once. The `deps` override exists for
   *  tests; asking for it at all 18 call sites only spread the question out. */
  private readonly store: typeof useConversationStore;

  constructor(private readonly deps: OrchestratorDeps) {
    this.store = deps.conversationStore ?? useConversationStore;
  }

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
    this.store.getState().setHfActivity(activity);
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

  /** Voxtral session options. `sessionMode` is what separates one persistent
   *  hands-free session from a single push-to-talk turn. */
  private sttOptions(cfg: OrchestratorConfig, sessionMode?: boolean) {
    return {
      apiKey: cfg.apiKey,
      model: cfg.sttModel ?? DEFAULT_STT_MODEL,
      sessionMode,
      targetStreamingDelayMs: cfg.sttStreamingDelayMs,
    };
  }

  // ── Transcript repair and interpreter context ─────────────────────────────

  /** The languages in play, as primary subtags. Hands-free knows its pair;
   *  push-to-talk knows the turn it is in the middle of. */
  private currentLangs(): readonly string[] {
    const pair = this.hfPairA && this.hfPairB ? [this.hfPairA, this.hfPairB] : null;
    const ptt = this.currentArgs
      ? [this.currentArgs.sourceLang, this.currentArgs.targetLang]
      : null;
    const langs = pair ?? ptt ?? [];
    return langs.map(primarySubtag);
  }

  /**
   * Rewrite names to their glossary spelling. Cheap by construction (a
   * phonetic-key lookup per word), so it can sit on the delta path where every
   * reader of the transcript sees the same words — see Utterance's constructor.
   */
  private repairTranscript(text: string): string {
    const people = this.config?.people ?? [];
    const langs = this.currentLangs();
    const key = `${people.join('|')}::${langs.join(',')}`;
    if (this.nameIndex === null || key !== this.nameIndexKey) {
      this.nameIndex = buildNameIndex(people, commonNamesFor(langs));
      this.nameIndexKey = key;
    }
    const result = repairNames(text, this.nameIndex, langs);
    for (const r of result.repairs) {
      const note = `${r.from}→${r.to}`;
      if (!this.repairsThisTurn.includes(note)) this.repairsThisTurn.push(note);
    }
    return result.text;
  }

  /**
   * What the translator gets besides the sentence: who is in the room, and
   * what has already been said.
   *
   * The history is what makes "pragmatic" possible rather than reckless. An
   * interpreter asked to repair an obvious recognition error needs something
   * to judge "obvious" against, and the previous exchange is that something —
   * without it, the instruction to interpret rather than transcribe is an
   * invitation to invent. Read at send time, so it never includes the turn
   * being translated.
   */
  private translationContext(): {
    names?: readonly string[];
    history?: readonly { source: string; translation: string }[];
  } | undefined {
    const names = this.config?.people ?? [];
    const history = this.store
      .getState()
      .turns.filter((t) => t.sourceText.length > 0 && t.translatedText.length > 0)
      .slice(-HISTORY_TURNS_AS_CONTEXT)
      .map((t) => ({ source: t.sourceText, translation: t.translatedText }));
    if (names.length === 0 && history.length === 0) return undefined;
    return { names, history };
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
    const store = this.store.getState();
    // A fresh press is the reader acting on the last notice — clear it.
    store.setNotice(args.speakerId, null);

    // If the system dialog appears, this press has physically ended underneath
    // it, so we never start recording on the same press: a grant means the NEXT
    // press works, a denial gets a speaker-side notice with the fix.
    this.beginning = true;
    try {
      let granted: boolean;
      try {
        granted = await this.deps.audioCapture.hasPermission();
      } catch {
        granted = true; // permission API unavailable — let the platform decide
      }
      if (!granted) {
        const now = await this.deps.audioCapture.requestPermission().catch(() => false);
        if (!now) store.setNotice(args.speakerId, { key: 'micPermission', kind: 'info' });
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
    this.repairsThisTurn = [];
    this.ttsChunkPromises = [];
    this.turnCompletionPromise = new Promise<void>((resolve) => {
      this.resolveTurnCompletion = resolve;
    });

    this.deps.tts.prewarm(args.targetLang);

    try {
      this.agc.reset();
      this.deps.audioCapture.startStreaming((base64Pcm) => {
        this.deps.voxtral.feedAudio(this.level(base64Pcm));
      });
    } catch (e) {
      this.failTurn(id, `Audio capture failed: ${errorMessage(e)}`);
      return;
    }

    try {
      await this.deps.voxtral.start(this.sttOptions(cfg), {
        onPartial: (text) => this.handlePartial(id, text),
        onFinal: (text) => this.handleFinal(id, text),
        onError: (err) => this.failTurn(id, err.message),
      });
    } catch (e) {
      // A quick release no longer aborts the handshake (the client flushes
      // the queued audio when the session opens), so a rejection here is a
      // real connection failure regardless of PTT state — surface it.
      log.error('[orch] Voxtral handshake rejected', toError(e));
      void this.deps.audioCapture.stopStreaming().catch(() => {});
      this.failTurn(id, `Voxtral handshake failed: ${errorMessage(e)}`);
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
      const store = this.store.getState();
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
      if (id) this.failTurn(id, `Voxtral end failed: ${errorMessage(e)}`);
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
      const store = this.store.getState();
      store.endTurn(id, { stage: 'done' });
      this.completeTurn(id);
    }
  }

  // ── Hands-Free API ────────────────────────────────────────────────────────

  /** Activate hands-free: load the VAD, start dual-path capture (→ Voxtral,
   *  → VAD), open a persistent Voxtral session, subscribe to VAD events. */
  async enableHandsFree(pairA: string, pairB: string): Promise<void> {
    if (this.hfEnabled) return;
    if (this.state !== 'idle') throw new Error('Cannot enable hands-free during an active PTT turn');
    if (!this.config?.apiKey) throw new Error('Orchestrator not configured (missing API key)');
    if (!this.deps.vad) throw new Error('No VAD service configured');

    // Checked BEFORE anything flips to hands-free: AudioRecord.start() without
    // RECORD_AUDIO dies in native code, where no JS try/catch sees it — the
    // process just ends. Unlike a PTT press, the toggle tap survives the system
    // dialog, so a grant continues straight into hands-free.
    let granted: boolean;
    try {
      granted = await this.deps.audioCapture.hasPermission();
    } catch {
      granted = true; // permission API unavailable — let the platform decide
    }
    if (!granted) granted = await this.deps.audioCapture.requestPermission().catch(() => false);
    if (!granted) {
      // The toggle isn't owned by either speaker — both readers see why
      // hands-free didn't start, each in their own language.
      const s = this.store.getState();
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
    this.endHfUtterance();
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

    log.info('[orch/hf] voices warming — switching UI to hands-free');
    const store = this.store.getState();
    store.setMode('hf');

    // Each step from here to "enabled — listening" hands off to native code
    // that can end the process without raising anything catchable, and a device
    // once died in this stretch. The log lines exist so the next one names the
    // step it died on.
    await this.deps.vad.initialize();
    log.info('[orch/hf] vad ready — starting capture');

    // Stop first: a failed PTT turn may have left streaming=true (failTurn).
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
    this.agc.reset();
    this.deps.audioCapture.startStreaming(this.hfOnAudio);

    await this.deps.voxtral.start(this.sttOptions(cfg, true), {
      onPartial: (text) => this.handleHfPartial(text),
      onFinal: () => { /* resolved via closeSegment — informational only */ },
      onError: (err) => this.handleHfError(err),
    });

    this.hfVadUnsub = this.deps.vad.subscribe(
      () => this.handleHfSpeechStart(),
      (lastSpeechAt) => {
        const u = this.hfUtterance;
        if (u) void this.takeTurn(u, 'silence', lastSpeechAt);
      },
      (lastSpeechAt) => this.handleHfSpeechPause(lastSpeechAt),
      () => this.handleHfSpeechResume(),
    );

    // Reset RNN state so stale state from a previous session doesn't suppress
    // speech detection at the start of the new one.
    this.deps.vad.resetState();
    // Always re-arm VAD on enable — disableHandsFree leaves it inactive.
    this.deps.vad.setActive(true);

    log.info('[orch/hf] enabled — listening');
  }

  /**
   * Deactivate hands-free. Safe from any HF sub-state.
   *
   * UI flags are cleared FIRST so the toggle and discs snap back instantly,
   * and resources torn down after: if stopStreaming stalls on Android (it has,
   * in production), the UI is still coherent.
   */
  async disableHandsFree(): Promise<void> {
    if (!this.hfEnabled) return;
    log.info('[orch/hf] disabling');

    this.hfPaused = false;
    this.hfEnabled = false;
    this.setHfState('hf-idle');

    // Everything the UI reads, synchronously — coherent before any await.
    const store = this.store.getState();
    store.setMode('ptt');
    store.setHfActiveSpeaker(null);
    store.setHfUnroutedSpeaker(null);
    store.setHfLive(null);

    // Abort any translation still streaming — its onSentence gate would abort
    // eventually, but doing it here is immediate.
    this.hfSkipRequested = true;
    try { this.hfTurnAbort?.abort(); } catch { /* noop */ }
    this.hfTurnAbort = null;
    this.endHfUtterance();

    this.hfVadUnsub?.();
    this.hfVadUnsub = null;
    this.deps.vad?.setActive(false);
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }

    try {
      if (this.deps.voxtral.endSession) {
        await this.deps.voxtral.endSession();
      } else {
        this.deps.voxtral.cancel();
      }
    } catch (e) {
      log.error('[orch/hf] endSession failed', toError(e));
    }
    try { this.deps.tts.stop(); } catch { /* noop */ }

    this.hfPairA = null;
    this.hfPairB = null;
    this.vadBuffer = new Int16Array(0);
    resetAudioLevel();

    log.info('[orch/hf] disabled');
  }

  /** Pause hands-free without tearing the session down — used when the device
   *  goes offline. Stops the mic and disarms VAD, but keeps `hfEnabled` so the
   *  UI stays in HF mode with its "paused — offline" microcopy. */
  async pauseHandsFree(): Promise<void> {
    if (!this.hfEnabled || this.hfPaused) return;
    log.info('[orch/hf] pausing — network offline');
    this.hfPaused = true;
    this.setHfState('hf-idle');
    this.vadBuffer = new Int16Array(0);
    this.endHfUtterance();
    resetAudioLevel();
    this.store.getState().setHfLive(null);
    this.deps.vad?.setActive(false);
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
  }

  /** Resume after a pause — same dual routing, VAD re-armed. */
  async resumeHandsFree(): Promise<void> {
    if (!this.hfEnabled || !this.hfPaused) return;
    log.info('[orch/hf] resuming — network online');
    try {
      this.agc.reset();
      this.deps.audioCapture.startStreaming(this.hfOnAudio);
    } catch (e) {
      log.error('[orch/hf] resume audio capture failed', toError(e));
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
   * Dual-path HF capture. While the phone speaks (and through the cooldown) the
   * mic hears the phone's own TTS, and that audio must not reach the Voxtral
   * session — the accumulator would grow an echo prefix the router later reads
   * as the other language, which is half a feedback loop.
   *
   * This gate is the whole defence: the capture path uses VOICE_RECOGNITION,
   * which offers no echo cancellation, so nothing downstream removes the
   * phone's own voice if this lets it through.
   */
  private readonly hfOnAudio = (base64Pcm: string): void => {
    // One question decides both consumers: the room talking, or the phone
    // hearing itself? Only the room may reach the transcriber or the wave.
    const fromTheRoom = this.hfState !== 'hf-speaking' && this.hfState !== 'hf-cooldown';
    // Decoded once, but they get different audio: the transcriber levelled, the
    // detector and meter raw. VAD thresholds are calibrated against the room,
    // and normalising underneath them would move the one measurement that must
    // not drift.
    const pcm = decodePcm16(base64Pcm);
    if (fromTheRoom) {
      const levelled = this.agc.process(pcm);
      this.deps.voxtral.feedAudio(
        levelled === pcm ? base64Pcm : encodePcm16(levelled),
      );
    }
    this.feedAudioToVad(pcm, fromTheRoom);
  };

  /** Level one push-to-talk chunk. Same normalisation as hands-free, minus the
   *  echo gate — a held button never overlaps playback. */
  private level(base64Pcm: string): string {
    const pcm = decodePcm16(base64Pcm);
    const levelled = this.agc.process(pcm);
    return levelled === pcm ? base64Pcm : encodePcm16(levelled);
  }

  /** Abandon whatever is being said. One call, because everything an utterance
   *  set in motion is reachable from it — disabling, pausing and reconnecting
   *  keep no lists of fields to clear. */
  private endHfUtterance(): void {
    this.hfUtterance?.end();
    this.hfUtterance?.cancelRun();
    this.hfUtterance = null;
  }

  /**
   * Nothing to route — back to listening, with the session's accumulator
   * scrubbed first.
   *
   * Audio keeps arriving while a turn is decided, and that accumulator is not
   * per-utterance: orphaned words left in it become the PREFIX of whatever the
   * next person says. The speaker sees one turn do nothing and the next carry
   * the wreckage of it, routed by text that is half somebody else's.
   */
  private discardUtterance(): void {
    this.deps.voxtral.resetUtterance?.();
    this.setHfState('hf-idle');
  }

  /** The utterance being spoken right now, if this is still its turn to speak.
   *  Anything async holds its own reference and compares it against this. */
  private current(u: Utterance): boolean {
    return (
      this.hfUtterance === u &&
      !u.ended &&
      this.hfEnabled &&
      !this.hfPaused &&
      this.hfState === 'hf-capturing'
    );
  }

  private handleHfSpeechStart(): void {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-idle') return;
    log.info('[orch/hf] speech_start → capturing');
    // A new object, not a reset: whatever the last utterance still has in the
    // air now answers to something nothing points at, and is dropped.
    this.endHfUtterance();
    this.hfUtterance = new Utterance((text) => this.repairTranscript(text));
    this.repairsThisTurn = [];
    this.setHfState('hf-capturing');
  }

  /** Send the translation on the transcript we already have, without waiting
   *  for the turn to be certain. Routing here may lean on weak evidence,
   *  unlike the endpoint shortcut, because this decision is reversible: an
   *  utterance that turns out otherwise discards the result unread. */
  private startTranslation(
    u: Utterance,
    text: string,
    sourceLang: string,
    targetLang: string,
  ): TranslationRun | null {
    const cfg = this.config;
    if (!cfg) return null;

    const run = new TranslationRun(text, sourceLang, targetLang);
    u.run = run;
    u.runCount++;

    void this.deps.translator
      .translateStream({
        signal: run.abort.signal,
        apiKey: cfg.apiKey,
        sourceText: text,
        sourceLang,
        targetLang,
        model: cfg.translationModel,
        context: this.translationContext(),
        onRequestOpen: () => run.noteOpen(Date.now()),
        onFirstToken: () => run.noteFirstToken(Date.now()),
        onDelta: (fullSoFar) => run.noteDelta(fullSoFar),
        onSentence: (sentence) => run.noteSentence(sentence),
        onDone: (fullText) => run.noteDone(fullText),
        onError: (err) => run.noteError(err),
      })
      .catch((e) => run.noteError(toError(e)));

    return run;
  }

  /** Start the translation ahead of the ending, if the transcript is worth
   *  guessing on. Speaker alternation is not evidence about THIS utterance and
   *  the turn it would guess can still change, so it never triggers one. */
  private speculate(u: Utterance): void {
    const text = u.text();
    if (text.length < FAST_PATH_MIN_CHARS) return;
    if (u.run !== null && sameUtterance(u.run.sourceText, text)) return;
    if (u.runCount >= MAX_SPECULATIONS_PER_UTTERANCE) return;

    const routing = this.routeUtterance(null, text);
    if (!routing || routing.kind === 'fallback') return;

    u.cancelRun();
    log.info(`[orch/hf] translating ahead of the ending (${routing.sourceLang}→${routing.targetLang})`);
    // The target voice is knowable now too — warm it while the request flies.
    this.deps.tts.prewarm(routing.targetLang);
    this.startTranslation(u, text, routing.sourceLang, routing.targetLang);
  }

  /**
   * The transcript, if it is safe to act on without the server's final: long
   * enough to be a sentence, no longer growing, and unambiguous about its
   * direction. That last condition is not fussiness — skipping the final also
   * skips the audio language tag, so the shortcut only exists where the text
   * alone decides outright. Anything the classifier merely leans towards goes
   * the slow way and keeps its second opinion.
   */
  private inspect(u: Utterance, now: number): { text: string | null; blocked: FastPathBlock } {
    const unclear = { text: null, blocked: 'routing-unclear' } as const;
    const text = u.text();
    if (text.length < FAST_PATH_MIN_CHARS) return { text: null, blocked: 'no-transcript' };
    if (!u.settled(now)) return { text: null, blocked: 'still-arriving' };

    const pair = this.pairSubtags();
    if (!pair) return unclear;
    const vote = classifyPairText(text, pair.a, pair.b);
    if (!vote) return unclear;
    const strictly = this.hfUntaggedStreak < UNTAGGED_UTTERANCES_TO_TRUST_TEXT;
    if (vote.strength !== 'strong' && strictly) return unclear;
    return { text, blocked: 'none' };
  }

  /** The configured pair as primary subtags, or null when it is unset or both
   *  halves speak the same language — neither routes anything. */
  private pairSubtags(): { a: string; b: string } | null {
    if (!this.hfPairA || !this.hfPairB) return null;
    const a = primarySubtag(this.hfPairA);
    const b = primarySubtag(this.hfPairB);
    return a === b ? null : { a, b };
  }

  /**
   * Early endpoint. The VAD noticed a short silence — not enough on its own to
   * call the turn over — but the transcript may know better. Ask for it, and
   * arm the check that reads it.
   */
  private handleHfSpeechPause(lastSpeechAt: number): void {
    const u = this.hfUtterance;
    if (!u || !this.current(u)) return;
    u.pauseHintAt = lastSpeechAt;
    u.armSettleCheck(() => this.closePause(u));
  }

  /**
   * The pause hint's answer: close the segment, then read what it says.
   *
   * Closing the instant the hint fires would put a segment boundary inside
   * whatever the server is still emitting, and both halves of that cost words.
   * The next segment starts with no memory of the sentence it continues, and
   * Voxtral is an LLM recogniser that leans on exactly those words when the
   * audio is ambiguous — which is what fast run-together speech IS. And if the
   * silence was a stop closure rather than a pause between words, the boundary
   * lands mid-word and both halves get written as something that is a word.
   *
   * Waiting for the transcript to settle removes both, and costs nothing in the
   * case the early close was built for: a short utterance streams no deltas, so
   * the check fires immediately.
   */
  private closePause(u: Utterance): void {
    if (u.pauseHintAt === null || !this.current(u)) return;
    if (!u.closedThisPause) {
      u.closedThisPause = true;
      this.closeSegment(u);
    }
    this.evaluateEndpoint(u);
  }

  /**
   * Ask for the transcript instead of waiting to be offered it.
   *
   * For a short utterance — most of a real conversation — Voxtral streams no
   * delta at all: every word arrives in the final, which is only requested once
   * the hangover concedes. The words exist nowhere until ~850 ms after the
   * speaker stopped, so every shortcut declined for want of a transcript
   * (measured: `no-transcript` on every short turn).
   *
   * Closing at the pause hint runs that round trip *during* the silence instead
   * of after it. An utterance that closes a sentence can then end early on
   * punctuated evidence, and one that does not still has its transcript in hand
   * when the hangover expires. The trip is its own safety margin: the answer
   * lands ~230 ms in, by which point a speaker who was only drawing breath has
   * resumed and cancelled everything this armed. Words spoken after the close
   * stream into a fresh segment and are joined back on.
   */
  private closeSegment(u: Utterance): SegmentClose | null {
    if (u.closing !== null) {
      u.noteLanguage(u.closing.language);
      return u.closing;
    }
    const close = this.deps.voxtral.closeSegment;
    if (!close) return null;

    const startedAt = Date.now();
    const closed = close.call(this.deps.voxtral, finalTimeoutFor(startedAt - u.startedAt));
    u.closing = closed;
    u.closedEarly = true;
    // A turn that does not wait for the answer would otherwise never see the
    // tag, and routing would think the server had stopped sending one.
    u.noteLanguage(closed.language);

    // Settling this handle is the only thing that lets the NEXT pause open a
    // close of its own, so both outcomes must clear it — including the ones
    // nobody is waiting on.
    closed.final.then(
      (r) => {
        u.closingMs = Date.now() - startedAt;
        u.closing = null;
        // The turn already took what it needed; this answer is for a segment
        // whose words are spoken by now.
        if (u.ended) return;
        try {
          u.absorbSegment(r.text, r.language);
          if (!this.current(u)) return;
          this.writeHfLive(u);
          this.evaluateEndpoint(u);
        } catch (e) {
          log.error('[orch/hf] segment handler threw', toError(e));
        }
      },
      (cause: unknown) => {
        u.closingMs = Date.now() - startedAt;
        u.closing = null;
        // Not an error the speaker should ever see: the hangover behind this
        // is the fallback, and it is about to run anyway.
        log.warn(`[orch/hf] segment close did not answer: ${errorMessage(cause)}`);
      },
    );
    return closed;
  }

  /** The speaker was not finished. */
  private handleHfSpeechResume(): void {
    const u = this.hfUtterance;
    if (!u || u.pauseHintAt === null) return;
    u.resumeSpeaking();
  }

  /**
   * Everything the pause hint armed, answered in one place: translate if there
   * is enough to guess on, and end the turn if the transcript says the speaker
   * is finished. Called whenever the evidence changes (settle timer, segment
   * answering), because the earliest moment we know what was said cannot be
   * predicted — Voxtral buffers audio, so at 400 ms of silence the words just
   * spoken are still in flight.
   */
  private evaluateEndpoint(u: Utterance): void {
    const pausedAt = u.pauseHintAt;
    if (pausedAt === null || !this.current(u)) return;

    // Whatever happens to the turn, the translation can start now. It is the
    // longest link in the chain, so the silence still being waited out below
    // is time it can spend in flight instead.
    this.speculate(u);

    const settled = this.inspect(u, Date.now()).text;
    if (settled === null || !CLOSED_THOUGHT_RE.test(settled)) return;
    log.info('[orch/hf] early endpoint — transcript closed a sentence');
    // Cancel the hangover that would otherwise deliver a second ending.
    this.deps.vad?.endUtterance?.();
    void this.takeTurn(u, 'punctuation', pausedAt);
  }

  /**
   * The utterance is over — take the turn. Reached two ways that differ by one
   * argument: the transcript closed a sentence during the pause hint
   * ('punctuation'), or the hangover conceded ('silence').
   *
   * One decision here: use the transcript in hand, or wait for the server's.
   * `inspect` answers it, and only ever says "wait" when the words are missing
   * or still arriving — when the round trip is what the speaker is waiting for
   * and there is nothing to save.
   */
  private async takeTurn(
    u: Utterance,
    endpoint: HfEndpoint,
    lastSpeechAt?: number,
  ): Promise<void> {
    if (!this.current(u)) return;
    if (!this.deps.voxtral.closeSegment) return;

    const vadEndAt = Date.now();
    // When the room actually went quiet — not when the hangover expired.
    // Every latency number below is measured from here, because this is where
    // the person starts waiting.
    const speechEndAt = lastSpeechAt ?? vadEndAt;
    const capturedMs = vadEndAt - u.startedAt;
    log.info(`[orch/hf] speech_end (${endpoint}) → closing (captured ${capturedMs} ms)`);
    u.end();
    this.setHfState('hf-flushing');

    const store = this.store.getState();
    const inspected = this.inspect(u, vadEndAt);
    const closeSentAt = Date.now();

    // Close the segment either way — the server has to, so the next speaker
    // starts clean. Whether we wait for its answer is the whole question.
    const closed = this.closeSegment(u);
    if (!closed) return;
    if (inspected.text === null) {
      // Nothing usable in hand. If a close was already sent at the pause hint
      // this is most of a round trip already paid for; otherwise it is the one
      // wait standing between a speaker and their turn, and it is unavoidable —
      // the words exist nowhere else.
      try {
        const final = await closed.final;
        u.absorbSegment(final.text, final.language);
      } catch (e) {
        log.error('[orch/hf] segment close failed', toError(e));
        store.setHfLive(null);
        if (this.hfEnabled) {
          this.setHfState('hf-idle');
          await this.attemptHfReconnect();
        }
        return;
      }
      if (!this.hfEnabled || this.hfPaused || this.getHfState() !== 'hf-flushing') return;
    }

    const closedAt = Date.now();
    const language = u.language;
    if (language) this.hfUntaggedStreak = 0;
    else if (this.hfUntaggedStreak < UNTAGGED_UTTERANCES_TO_TRUST_TEXT) {
      this.hfUntaggedStreak++;
    }

    // The live partial's job ends where the routed turn begins.
    store.setHfLive(null);
    if (!this.hfEnabled) return;

    const trimmed = u.text().trim();
    if (trimmed.length === 0) return this.discardUtterance();

    const routing = this.routeUtterance(language ?? null, trimmed);
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!routing) {
      if (pairA && pairB) {
        log.info(
          `[hf_turn] ${JSON.stringify({
            kind: 'hf_turn',
            routedLanguage: language ?? null,
            configuredPair: [pairA, pairB],
            routingResult: 'mismatched',
            utteranceWordCount: wordCount(trimmed),
          })}`,
        );
      }
      return this.discardUtterance();
    }

    const { speakerId, sourceLang, targetLang, kind: routingKind } = routing;
    this.setHfState('hf-routing');
    store.setHfActiveSpeaker(speakerId);

    await this.dispatchHfTurn(u, speakerId, sourceLang, targetLang, trimmed, {
      speechEndAt,
      vadEndAt,
      closeSentAt,
      closedAt,
      endpoint,
      transcriptSource: inspected.text !== null ? 'settled-partial' : 'server-final',
      fastPathBlock: inspected.blocked,
      earlyClose: !u.closedEarly ? 'none' : inspected.text !== null ? 'used' : 'empty',
      earlyCloseMs: u.closingMs,
      untaggedStreak: this.hfUntaggedStreak,
      routedLanguage: language ?? null,
      configuredPair: [pairA ?? '', pairB ?? ''],
      routingResult: routingKind,
    });

    if (this.hfEnabled) {
      store.setHfActiveSpeaker(null);
      this.setHfState('hf-cooldown');
      // Conversations alternate, so the next turn almost always needs the voice
      // we did NOT just speak. Selecting it in the cooldown costs nobody
      // anything, and a wrong guess only pays a switch it owed anyway.
      //
      // Selecting, not warming: prewarm's silent primer is a real
      // synth-and-play cycle, and on device it sat in the native queue ahead of
      // the next reply and roughly tripled its queue-to-audio time.
      const nextVoice = otherOfPair(targetLang, pairA, pairB);
      if (nextVoice) this.deps.tts.presetVoice(nextVoice);
      await new Promise<void>((r) => setTimeout(r, HF_COOLDOWN_MS));
      if (this.hfEnabled && !this.hfPaused) {
        // Scrub what leaked past the capture gate — chunks in flight when the
        // state flipped — before listening for the next speaker.
        this.discardUtterance();
        this.deps.vad?.setActive(true);
      } else if (this.hfEnabled) {
        this.setHfState('hf-idle');
      }
    }
  }

  private routeUtterance(detectedLang: string | null, text: string): Routing | null {
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!pairA || !pairB) return null;

    const toward = (side: 'a' | 'b', kind: HfRoutingKind): Routing =>
      side === 'a'
        ? { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind }
        : { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind };

    const pair = this.pairSubtags();
    if (pair) {
      const dl = detectedLang ? primarySubtag(detectedLang) : null;
      const audioVote: 'a' | 'b' | null = dl === pair.a ? 'a' : dl === pair.b ? 'b' : null;

      // The transcript outranks the audio tag: it is the very text about to be
      // translated, so ITS language decides which direction produces a real
      // translation. The tag misfires often enough — Spanish tagged en, Catalan
      // for Spanish, missing altogether — that trusting it alone made HF
      // "translate" Spanish into Spanish and parrot the speaker. Strong text
      // overrides a contradicting tag; weak text only fills in for a tag that
      // abstained; both beat blind alternation.
      const textVote = classifyPairText(text, pair.a, pair.b);
      const textSide =
        textVote && (textVote.strength === 'strong' || audioVote === null)
          ? textVote.side
          : null;
      const side = textSide ?? audioVote;

      if (side !== null) {
        if (textSide === null) return toward(side, 'matched');
        if (audioVote === null || audioVote === textSide) return toward(side, 'text');
        log.warn(
          `[orch/hf] transcript overrides audio tag lang=${detectedLang} → ${side === 'a' ? pair.a : pair.b} text="${text.slice(0, 30)}"`,
        );
        return toward(side, 'text-override');
      }

      if (detectedLang) {
        // Outside the pair, and the transcript claims neither side. Discard it,
        // flashing the half whose turn it most likely was.
        log.info(`[orch/hf] unrouted utterance lang=${detectedLang} text="${text.slice(0, 30)}"`);
        const store = this.store.getState();
        store.setHfUnroutedSpeaker(otherPerson(this.lastSpeaker() ?? 'person_b'));
        setTimeout(() => {
          if (this.hfEnabled) store.setHfUnroutedSpeaker(null);
        }, 600);
        return null;
      }
    }

    // No usable evidence (or both halves speak the same language) — alternate
    // from the last routed turn; the first turn goes to person_a.
    return toward(this.lastSpeaker() === 'person_a' ? 'b' : 'a', 'fallback');
  }

  /** Who spoke the last completed turn, if anyone has yet. */
  private lastSpeaker(): PersonId | null {
    const turns = this.store.getState().turns;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].stage === 'done') return turns[i].speakerId;
    }
    return null;
  }

  /** Whether the direction was decided WITHOUT reading the transcript. 'text'
   *  and 'text-override' read the very words about to be translated and are
   *  trusted; 'matched' took the word of the tag observed calling Spanish
   *  English, and 'fallback' just alternated. Those two are worth checking. */
  private directionWasGuessed(kind: HfRoutingKind): boolean {
    return kind === 'fallback' || kind === 'matched';
  }

  /**
   * Ask the translation whether the direction was right, before anyone sees or
   * hears it.
   *
   * A guessed direction fails in one humiliating way: asked to translate a
   * language into itself, the model returns the sentence unchanged and the app
   * reads the speaker their own words back. It survives in exactly the case
   * routing has no evidence for — a short utterance the lexicon cannot place,
   * on a device where the audio tag never arrives. "Genial." came back
   * "Genial."
   *
   * So the guess is read before it is shown. If it returned its own input the
   * other direction is tried, and whichever produced a real translation wins.
   * If BOTH come back unchanged the word genuinely survives translation
   * ("Madrid", "OK") and the original stands. Two requests is the cap, and only
   * on a direction nobody had evidence for.
   *
   * The cost is that these turns don't stream to the screen while they run —
   * affordable because it is only the ambiguous ones that get here, and a
   * transcript the lexicon cannot place is a handful of words.
   */
  private async confirmDirection(
    u: Utterance,
    guess: TranslationRun,
    sourceText: string,
    dir: Direction,
  ): Promise<{ run: TranslationRun; dir: Direction; flipped: boolean } | null> {
    await guess.settled();
    if (!this.hfEnabled || u.run !== guess) return null;
    if (!guess.returnedItsInput(sourceText)) return { run: guess, dir, flipped: false };

    const other: Direction = {
      speakerId: otherPerson(dir.speakerId),
      sourceLang: dir.targetLang,
      targetLang: dir.sourceLang,
    };
    log.warn(
      `[orch/hf] ${dir.sourceLang}→${dir.targetLang} returned its own input — ` +
      `trying ${other.sourceLang}→${other.targetLang} for "${sourceText.slice(0, 30)}"`,
    );
    const retry = this.startTranslation(u, sourceText, other.sourceLang, other.targetLang);
    if (!retry) return { run: guess, dir, flipped: false };
    await retry.settled();
    if (!this.hfEnabled || u.run !== retry) return null;

    // Unchanged both ways: the word is the same in both languages, and the
    // direction we guessed is as good as the one we tried.
    if (retry.returnedItsInput(sourceText)) {
      log.info('[orch/hf] unchanged in both directions — the word survives translation');
      return { run: retry, dir, flipped: false };
    }
    return { run: retry, dir: other, flipped: true };
  }

  private async dispatchHfTurn(
    u: Utterance,
    speakerId: PersonId,
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    telemetry: {
      speechEndAt: number;
      vadEndAt: number;
      closeSentAt: number;
      closedAt: number;
      endpoint: HfEndpoint;
      transcriptSource: 'settled-partial' | 'server-final';
      fastPathBlock: FastPathBlock;
      earlyClose: EarlyCloseOutcome;

      /** Duration of the pause-hint round trip. Off the critical path — it ran
       *  inside endpointDelay — so it is reported, not summed. */
      earlyCloseMs: number;
      untaggedStreak: number;
      routedLanguage: string | null;
      configuredPair: [string, string];
      routingResult: HfRoutingKind;
    },
  ): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;

    const store = this.store.getState();
    this.setHfState('hf-speaking');
    this.deps.vad?.setActive(false);

    // A translation may already be in flight from the pause hint. Keep it only
    // if it is a translation of THIS utterance, in THIS direction — otherwise
    // it is a guess that missed, and it is discarded unread.
    const guess = u.run;
    const speculative = guess !== null && guess.answers(sourceText, sourceLang, targetLang);
    if (guess !== null && !speculative) {
      log.info('[orch/hf] speculative translation discarded — the utterance changed');
      u.cancelRun();
    }
    // One path from here: either the run that was already flying, or one sent
    // now. A turn attaches to it the same way in both cases.
    let run = speculative
      ? guess
      : this.startTranslation(u, sourceText, sourceLang, targetLang);
    if (!run) return;

    let dir = { speakerId, sourceLang, targetLang };
    let flipped = false;
    if (!speculative && this.directionWasGuessed(telemetry.routingResult)) {
      const settled = await this.confirmDirection(u, run, sourceText, dir);
      if (settled === null) return;
      run = settled.run;
      dir = settled.dir;
      flipped = settled.flipped;
    }
    ({ speakerId, sourceLang, targetLang } = dir);
    if (flipped) store.setHfActiveSpeaker(speakerId);

    const id = turnId();
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
    this.deps.tts.prewarm(targetLang);

    const abort = run.abort;
    this.hfTurnAbort = abort;
    this.hfSkipRequested = false;
    const listenerId = otherPerson(speakerId);
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

    await run.attach(sink);
    requestOpenAt = run.openedAt;

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
    const finalAt = telemetry.closedAt;
    const since = (t: number | null): number =>
      t !== null ? t - telemetry.speechEndAt : -1;
    const payload = {
      kind: 'hf_turn' as const,
      endpoint: telemetry.endpoint,
      transcript: telemetry.transcriptSource,
      fastPathBlock: telemetry.fastPathBlock,
      earlyClose: telemetry.earlyClose,
      earlyCloseMs: telemetry.earlyCloseMs,
      untaggedStreak: telemetry.untaggedStreak,
      // Whether a guessed direction was checked, and whether checking changed
      // it. 'kept' is the check running and finding nothing wrong, which must
      // not look like the check never running at all.
      direction: !this.directionWasGuessed(telemetry.routingResult)
        ? 'from-transcript'
        : flipped ? 'flipped' : 'kept',
      translation: speculative ? 'speculative' : 'fresh',
      // How much of the request flew before the turn was even certain.
      translationLead: speculative ? finalAt - run.startedAt : 0,
      // The number that matters: silence → first audible word.
      speechEndToAudio: since(firstAudioAt),
      endpointDelay: telemetry.vadEndAt - telemetry.speechEndAt,
      vadEndToClose: telemetry.closeSentAt - telemetry.vadEndAt,
      closeToFinal: finalAt - telemetry.closeSentAt,
      finalToFirstToken: firstTokenAt !== null ? firstTokenAt - finalAt : -1,
      // The two halves of the request's own cost: getting answered (connection,
      // queue, prefill) versus the model writing. They need different fixes.
      requestToOpen: requestOpenAt !== null ? requestOpenAt - run.startedAt : -1,
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
      // What the microphone actually delivered, and what was done about it.
      // A conversation that transcribes badly at -50 dBFS is a placement
      // problem, not a model problem, and there was no way to tell before.
      micDbfs: Math.round(this.agc.inputDbfs),
      agcGainDb: Math.round(this.agc.currentGainDb * 10) / 10,
      // Names put right on the way in. Empty is the normal case; a repair that
      // fires on ordinary speech has to be visible somewhere to be caught.
      nameRepairs: this.repairsThisTurn,
    };
    log.info(`[hf_turn] ${JSON.stringify(payload)}`);
  }

  /** Streaming HF partials → the transient `hfLive` field, never a turn: turns
   *  don't exist until the utterance is flushed and routed. */
  private handleHfPartial(text: string): void {
    const u = this.hfUtterance;
    if (!u || u.ended || !this.hfEnabled || this.hfPaused) return;
    if (this.hfState !== 'hf-capturing' && this.hfState !== 'hf-flushing') return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const now = Date.now();
    // Record every delta. The store write below is throttled because the
    // screen cannot use 30 updates a second, but the endpoint decision is
    // precisely a question about WHEN the transcript last grew — sampled
    // through a throttle, a sentence still arriving would look finished.
    u.noteDelta(trimmed, now);
    // The transcript just grew, so it has not settled after all — push the
    // check back rather than closing through a half-delivered sentence.
    u.armSettleCheck(() => this.closePause(u));
    if (now - this.hfLastPartialWriteAt < HF_PARTIAL_WRITE_THROTTLE_MS) return;
    this.hfLastPartialWriteAt = now;
    this.writeHfLive(u);
  }

  /**
   * Put the utterance so far on the speaker's own half — including segments
   * already closed, or the caption would jump backwards to just the words
   * spoken since.
   *
   * The side is the classifier's live guess, sticky for the rest of the
   * utterance so the caption doesn't hop across the seam mid-sentence. Until
   * there is enough text to call one, nothing renders: a caption on the wrong
   * half is worse than a beat of silence.
   */
  private writeHfLive(u: Utterance): void {
    const text = u.text();
    if (text.length === 0) return;
    const pair = u.side === null ? this.pairSubtags() : null;
    if (pair) {
      const vote = classifyPairText(text, pair.a, pair.b);
      if (vote) u.side = vote.side === 'a' ? 'person_a' : 'person_b';
    }
    this.store.getState().setHfLive({ side: u.side, text });
  }

  /** Cut the in-flight HF turn short — the reader tapped the streaming
   *  translation. The turn ends quietly as 'done' with whatever text arrived,
   *  then cooldown and listening resume: the door out of a long readback
   *  nobody needs spoken to the end. */
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
    this.endHfUtterance();
    this.store.getState().setHfLive(null);
    this.setHfState('hf-idle');

    log.info('[orch/hf] reconnecting in 500 ms');
    await new Promise<void>((r) => setTimeout(r, 500));
    if (!this.hfEnabled) return;

    try {
      await this.deps.voxtral.start(this.sttOptions(cfg, true), {
        onPartial: (text) => this.handleHfPartial(text),
        onFinal: () => {},
        onError: (err) => {
          log.error('[orch/hf] reconnect failed, disabling HF', err);
          void this.disableHandsFree();
        },
      });
      // Re-arm VAD only after the new session is open.
      this.deps.vad?.setActive(true);
      log.info('[orch/hf] reconnected');
    } catch (e) {
      log.error('[orch/hf] reconnect attempt failed', toError(e));
      void this.disableHandsFree();
    }
  }

  // ── VAD audio routing ─────────────────────────────────────────────────────

  /**
   * Drain one capture chunk into the VAD as 512-sample frames — RAW samples,
   * before SpeechAgc, since the detector's thresholds are calibrated against
   * the room.
   *
   * `fromTheRoom` also gates the level meter: the frames that feed turn
   * detection carry the loudness that drives the seam wave, so it is published
   * here rather than in a second pass. Frame cadence IS meter cadence — 32 ms,
   * ~31 updates/s — which is what makes the wave track a voice.
   */
  private feedAudioToVad(incoming: Int16Array, fromTheRoom: boolean): void {
    if (!this.deps.vad || !this.hfEnabled || this.hfPaused) return;
    if (incoming.length === 0) return;

    if (!this.hfFirstAudioLogged) {
      this.hfFirstAudioLogged = true;
      log.info('[orch/hf] audio→vad: first chunk received');
    }

    // Capped so a wedged inferencer that stops draining can't grow the heap.
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
        log.error('[orch/hf] VAD feedFrame threw', toError(e));
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
    const store = this.store.getState();
    // Repaired here as well as in the final, so the speaker watching their own
    // words appear never sees a name spelled one way and then another.
    store.updateTurn(turnId, { sourceText: this.repairTranscript(partial) });
  }

  private handleFinal(turnId: string, finalText: string): void {
    if (turnId !== this.activeTurnId) return;
    void this.dispatchTranslation(turnId, this.repairTranscript(finalText)).catch((e) => {
      this.failTurn(turnId, `Pipeline error: ${errorMessage(e)}`);
    });
  }

  private async dispatchTranslation(turnId: string, finalText: string): Promise<void> {
    const args = this.currentArgs;
    const cfg = this.config;
    if (!args || !cfg) return;

    const store = this.store.getState();
    const trimmed = finalText.trim();
    if (trimmed.length === 0) {
      // "Did it hear me?" must never be left open: an empty transcript gets
      // a quiet speaker-side notice instead of vanishing without a trace.
      store.endTurn(turnId, { sourceText: '', translatedText: '', stage: 'done' });
      store.setNotice(args.speakerId, { key: 'didntCatch', kind: 'info' });
      this.completeTurn(turnId);
      return;
    }

    // A transcript in the wrong writing system is not a bad guess at what was
    // said — it is evidence the transcriber heard something else entirely.
    // Translating it anyway sends text labelled as a language it is not, and
    // reads the result to a listener with no way to tell a mistranscription
    // from the speaker actually saying it. The speaker, meanwhile, is right
    // there holding the button: "I didn't catch that" is true and actionable,
    // which is why this joins the empty-transcript path.
    if (!writtenInScriptOf(trimmed, primarySubtag(args.sourceLang))) {
      log.warn(
        `[orch] transcript is not written in ${args.sourceLang} — dropping it ` +
        `rather than translating it: ${JSON.stringify(trimmed.slice(0, 60))}`,
      );
      store.endTurn(turnId, { sourceText: '', translatedText: '', stage: 'done' });
      store.setNotice(args.speakerId, { key: 'didntCatch', kind: 'info' });
      this.completeTurn(turnId);
      return;
    }

    store.updateTurn(turnId, { sourceText: trimmed, stage: 'translating' });
    this.state = 'translating';

    const abort = new AbortController();
    this.translationAbort = abort;

    const listenerId = otherPerson(args.speakerId);
    let translationFailed = false;
    let lastDeltaWriteAt = 0;

    await this.deps.translator.translateStream({
      signal: abort.signal,
      apiKey: cfg.apiKey,
      sourceText: trimmed,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: cfg.translationModel,
      context: this.translationContext(),
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
    const store = this.store.getState();
    store.setNotice(listenerId, { key: 'noVoice', kind: 'info', lang: targetLang });
  }

  private failTurn(turnId: string, message: string): void {
    if (turnId !== this.activeTurnId) return;
    // The raw message goes to the log; the store gets a NoticeKey rendered in
    // the SPEAKER's language on their own half — they are the one person who
    // can act (press again, check Settings), and the old behavior handed the
    // raw English error to the listener instead.
    log.error(`[orch] turn failed: ${message}`);
    const store = this.store.getState();
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

/** BCP-47 primary subtag — "es-MX" → "es", "EN" → "en". */
function primarySubtag(lang: string): string {
  const idx = lang.indexOf('-');
  return (idx === -1 ? lang : lang.slice(0, idx)).toLowerCase();
}

/** The other half of the conversation. */
function otherPerson(id: PersonId): PersonId {
  return id === 'person_a' ? 'person_b' : 'person_a';
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
