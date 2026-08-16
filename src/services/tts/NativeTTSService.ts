// NativeTTSService — wraps react-native-tts with a chunked queue, voice
// pre-resolution, and a "speculative warmup" hook used to load the engine
// before the first real sentence arrives.
//
// Why the per-utterance ID matching?
//   `react-native-tts` fires `tts-finish` for ANY utterance, not just the
//   one the caller awaited. If we naively resolve on the first finish event
//   after speak(), back-to-back chunked emits would all resolve on the first
//   chunk's finish — completely wrong. We resolve only when the matching
//   utteranceId fires.
//
// Why two timeouts (playback + enqueue)?
//   The naive single-timer-from-speak() approach fired prematurely on long
//   messages: a 50-word sentence at slow rate plays >25 s, and chunks N+1,
//   N+2 sit in the native queue while chunk N plays — their timer is
//   already counting before they ever start. The fix is to arm the per-
//   chunk cap on `tts-start` (so it measures actual playback) and keep a
//   generous enqueue fallback for the case where `tts-start` never fires
//   (engine stalled before producing any audio for this chunk).

import Tts from 'react-native-tts';
import { errorMessage } from '../../app/errors';
import type { TtsEventHandler, TtsEvents } from 'react-native-tts';

// react-native-tts (Android) transforms this: rate≥0.5 → androidRate = rate*4-1.
// 0.55 → 1.2 (≈20% faster than normal), so the spoken translation finishes
// sooner and turns feel snappier without hurting comprehensibility. 0.5→1.0
// (normal), 0.6→1.4. Tune here if speech feels rushed or sluggish.
const SPEECH_RATE = 0.55;
// Cap measured from this chunk's `tts-start` event. Long enough that a
// slow-rate full sentence never trips it; short enough to recover from a
// hung engine mid-utterance.
const PLAYBACK_TIMEOUT_MS = 120_000;
// Cap measured from speak() acceptance. Catches the rare case where
// `tts-start` never fires (engine stuck, chunk dropped). Generous enough
// to tolerate a deep queue of preceding chunks playing first.
const ENQUEUE_TIMEOUT_MS = 300_000;
// How long a voice stays hot after a warmup. The silent primer costs a full
// synth+play cycle in the native engine, and prewarm() is called several
// times per turn (turn start, first translated token) — queued in front of
// the sentence the listener is waiting for, that is latency we are adding to
// save latency. Re-warm only after a real lull.
const WARM_TTL_MS = 20_000;

interface CachedVoice {
  readonly id: string;
  readonly language: string;
}

/** What `Tts.addEventListener` hands back. Detaching through the subscription
 *  is the only option left: RN dropped `NativeEventEmitter.removeListener`, so
 *  the library's own `removeEventListener` — which calls it — throws. */
interface TtsSubscription {
  remove?(): void;
}

type AddTtsListener = <T extends TtsEvents>(
  type: T,
  handler: TtsEventHandler<T>,
) => TtsSubscription;

// SAFETY: the library declares this as returning void while returning
// `this.addListener(...)`. The declaration is what is wrong, not the runtime.
const addTtsListener = Tts.addEventListener as AddTtsListener;

/**
 * Result of a speakChunk call.
 *  - 'spoken'   — played to completion (or intentionally stopped).
 *  - 'no-voice' — the device has no voice for the requested language; the
 *                 chunk was NOT read with a wrong-language voice (Spanish
 *                 text in English phonemes is worse than silence). The
 *                 orchestrator surfaces a per-language notice.
 *  - 'error'    — the engine accepted the chunk but reported tts-error.
 *  - 'skipped'  — empty text or the engine rejected the enqueue.
 */
export type SpeakOutcome = 'spoken' | 'no-voice' | 'error' | 'skipped';

class NativeTTSService {
  private initialized = false;
  private voicesByLang = new Map<string, CachedVoice>();
  private currentLang: string | null = null;
  /** Base languages for which every voice lookup + locale fallback failed —
   *  cached so we don't retry the whole ladder on every chunk. */
  private unavailableLangs = new Set<string>();
  private cancelAllPending: Set<() => void> = new Set();
  /** When each base language was last primed with the silent warmup. */
  private warmedAt = new Map<string, number>();
  /** Tail of the voice-switch queue — see `serial()`. */
  private lane: Promise<unknown> = Promise.resolve();

  /**
   * Run voice-switching work one at a time. `prewarm` and `speakChunk` both
   * mutate the engine's active voice and both cache the result in
   * `currentLang`. Interleaved, the slower one can land last and leave
   * `currentLang` naming a voice the engine no longer has — after which the
   * next chunk in that language takes the "already applied" shortcut and gets
   * read in another language's phonemes. Serialising makes the cache honest.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lane.then(work, work);
    this.lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Load engine + cache voices. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await Tts.getInitStatus();
      this.initialized = true;
      await this.cacheVoices();
      Tts.setDefaultRate(SPEECH_RATE);
    } catch (e: unknown) {
      console.warn('[NativeTTSService] TTS init failed:', errorMessage(e));
    }
  }

  private async cacheVoices(): Promise<void> {
    try {
      const voices = await Tts.voices();
      for (const v of voices) {
        if (v.notInstalled) continue;
        const lang = baseLanguage(v.language);
        if (!this.voicesByLang.has(lang)) {
          this.voicesByLang.set(lang, { id: v.id, language: v.language });
        }
      }
    } catch {
      /* voices() not available — fall back to setDefaultLanguage path */
    }
  }

  /**
   * Apply the voice/language for the next utterance. Cached per language.
   * Returns whether a voice (or locale) for this language was actually
   * applied. On false, the PREVIOUS voice is still active — callers must
   * not speak, or the text gets read in the wrong language's phonemes.
   *
   * Never call this directly — go through `serial()`.
   */
  private async applyLanguageNow(language: string): Promise<boolean> {
    const baseLang = baseLanguage(language);
    if (this.currentLang === baseLang) return true;
    if (this.unavailableLangs.has(baseLang)) return false;
    const cached = this.voicesByLang.get(baseLang);
    if (cached) {
      try {
        await Tts.setDefaultVoice(cached.id);
        this.currentLang = baseLang;
        return true;
      } catch {
        /* fall through to language fallback */
      }
    }
    const locale = toTtsLocale(baseLang);
    try {
      await Tts.setDefaultLanguage(locale);
      this.currentLang = baseLang;
      return true;
    } catch {
      try {
        await Tts.setDefaultLanguage(language);
        this.currentLang = baseLang;
        return true;
      } catch {
        this.unavailableLangs.add(baseLang);
        return false;
      }
    }
  }

  /** Whether a voice for `language` is known to be unavailable. Only
   *  meaningful after an applyLanguage attempt (speakChunk/prewarm). */
  hasVoiceFor(language: string): boolean {
    return !this.unavailableLangs.has(baseLanguage(language));
  }

  /**
   * Select the voice for `language` without speaking anything.
   *
   * The full `prewarm` below queues a silent primer, which is a real
   * synth-and-play cycle in the native engine — fine before a conversation
   * starts, ruinous between turns: measured on device, priming during the
   * cooldown roughly tripled the queue-to-audio time of the next sentence,
   * because the primer was still ahead of it in the native queue.
   *
   * This does only the half that is safe to do early. `speakChunk` awaits the
   * voice switch before it can enqueue anything, so having it already applied
   * takes that switch off the front of the reply — with nothing left sitting
   * in the queue behind it.
   */
  presetVoice(language: string): void {
    void this.serial(async () => {
      if (!this.initialized) await this.init();
      await this.applyLanguageNow(language);
    });
  }

  /**
   * Speculative warmup — load the voice engine for `language` so the first
   * real sentence's TTS first-audio-frame latency drops by ~100-300 ms on
   * Android. Speaks a single space character (inaudible) and does not await.
   *
   * Safe to call often: the silent primer is only actually spoken when the
   * voice changed or went cold (WARM_TTL_MS). A primer queued behind a voice
   * that is already hot delays the real sentence instead of helping it.
   */
  prewarm(language: string): void {
    void this.serial(async () => {
      if (!this.initialized) await this.init();
      const base = baseLanguage(language);
      const alreadyActive = this.currentLang === base;
      const voiceReady = await this.applyLanguageNow(language);
      if (!voiceReady) return; // nothing to warm — and don't warm the wrong voice
      const hot = Date.now() - (this.warmedAt.get(base) ?? 0) < WARM_TTL_MS;
      if (alreadyActive && hot) return;
      this.warmedAt.set(base, Date.now());
      try {
        // Returns a Promise<utteranceId> — fire and forget.
        void Tts.speak(' ');
      } catch {
        /* best-effort */
      }
    });
  }

  /**
   * Speak `text` in `language`. Resolves when this specific utterance
   * finishes (tts-finish with the matching utteranceId), is cancelled, or
   * errors. Multiple consecutive calls queue in order — react-native-tts
   * native engine handles the queuing.
   *
   * `onStart` fires when the engine begins playing THIS chunk — the moment
   * the listener actually hears something, which is the only end point a
   * latency measurement may honestly use.
   */
  async speakChunk(
    text: string,
    language: string,
    onStart?: () => void,
  ): Promise<SpeakOutcome> {
    if (!text.trim()) return 'skipped';
    if (!this.initialized) await this.init();
    const voiceReady = await this.serial(() => this.applyLanguageNow(language));
    if (!voiceReady) return 'no-voice';

    // Tts.speak() resolves to the utteranceId once accepted by the native
    // engine. We then await its tts-finish/tts-cancel/tts-error event.
    let utteranceId: string | number;
    try {
      // speak() resolves the id once the engine accepts the chunk, though its
      // types say it returns the id directly. Promise.resolve adopts it under
      // either reading, and keeps a rejection a rejection.
      utteranceId = await Promise.resolve(Tts.speak(text));
    } catch (e) {
      console.warn('[NativeTTSService] speak() rejected:', e);
      return 'skipped';
    }

    return new Promise<SpeakOutcome>((resolve) => {
      let done = false;
      let playbackTimer: ReturnType<typeof setTimeout> | null = null;
      let startSub: TtsSubscription | null = null;
      let finishSub: TtsSubscription | null = null;
      let cancelSub: TtsSubscription | null = null;
      let errorSub: TtsSubscription | null = null;

      const finish = (outcome: SpeakOutcome) => {
        if (done) return;
        done = true;
        startSub?.remove?.();
        finishSub?.remove?.();
        cancelSub?.remove?.();
        errorSub?.remove?.();
        if (playbackTimer) clearTimeout(playbackTimer);
        clearTimeout(enqueueTimer);
        this.cancelAllPending.delete(forceCancel);
        resolve(outcome);
      };
      const forceCancel = () => finish('spoken');
      this.cancelAllPending.add(forceCancel);

      // Pre-playback fallback. Fires only if `tts-start` never arrives —
      // the chunk got dropped or the engine is stuck before producing any
      // audio for it. Generous enough to wait through a deep queue of
      // preceding chunks playing first.
      const enqueueTimer = setTimeout(() => finish('skipped'), ENQUEUE_TIMEOUT_MS);

      const matches = (ev: { utteranceId: string | number }): boolean =>
        ev.utteranceId === utteranceId || ev.utteranceId === String(utteranceId);

      startSub = addTtsListener('tts-start', (ev) => {
        if (!matches(ev)) return;
        // Playback for THIS chunk just began. Arm the playback cap from
        // here so the timer measures actual audio time, not queue wait.
        if (playbackTimer) clearTimeout(playbackTimer);
        playbackTimer = setTimeout(() => finish('spoken'), PLAYBACK_TIMEOUT_MS);
        try {
          onStart?.();
        } catch {
          /* a broken observer must never break playback */
        }
      });
      finishSub = addTtsListener('tts-finish', (ev) => {
        if (matches(ev)) finish('spoken');
      });
      cancelSub = addTtsListener('tts-cancel', (ev) => {
        if (matches(ev)) finish('spoken');
      });
      errorSub = addTtsListener('tts-error', (ev) => {
        // Report distinctly — resolving an engine failure as success was how
        // "no audio, no explanation" shipped.
        if (matches(ev)) finish('error');
      });
    });
  }

  /** Stop the current utterance AND clear the native queue. */
  stop(): void {
    Tts.stop();
    for (const cancel of this.cancelAllPending) cancel();
    this.cancelAllPending.clear();
  }
}

export const nativeTTSService = new NativeTTSService();

/** BCP-47 primary subtag, lowercased — "pt-BR" and "pt_br" both → "pt". */
function baseLanguage(lang: string): string {
  return lang.split(/[-_]/)[0].toLowerCase();
}

/** The locale each short code stands in for when the engine wants a full
 *  BCP-47 tag. Built once — it was being rebuilt on every chunk. */
const TTS_LOCALES = new Map<string, string>(Object.entries({
  en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
  pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', ru: 'ru-RU', ja: 'ja-JP',
  ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR',
  sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', no: 'nb-NO', el: 'el-GR',
  cs: 'cs-CZ', ro: 'ro-RO', hu: 'hu-HU', uk: 'uk-UA', th: 'th-TH',
  vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', ca: 'ca-ES', he: 'he-IL',
  bg: 'bg-BG', hr: 'hr-HR', sk: 'sk-SK', sl: 'sl-SI', bn: 'bn-IN',
  ur: 'ur-PK', fa: 'fa-IR', sw: 'sw-TZ',
}));

/** BCP-47 locale fallback for short language codes. */
function toTtsLocale(lang: string): string {
  if (lang.includes('-') || lang.includes('_')) return lang;
  return TTS_LOCALES.get(lang) ?? lang;
}
