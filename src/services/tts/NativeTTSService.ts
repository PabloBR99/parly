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

const SPEECH_RATE = 0.5;
// Cap measured from this chunk's `tts-start` event. Long enough that a
// slow-rate full sentence never trips it; short enough to recover from a
// hung engine mid-utterance.
const PLAYBACK_TIMEOUT_MS = 120_000;
// Cap measured from speak() acceptance. Catches the rare case where
// `tts-start` never fires (engine stuck, chunk dropped). Generous enough
// to tolerate a deep queue of preceding chunks playing first.
const ENQUEUE_TIMEOUT_MS = 300_000;

interface CachedVoice {
  readonly id: string;
  readonly language: string;
}

class NativeTTSService {
  private initialized = false;
  private voicesByLang = new Map<string, CachedVoice>();
  private currentLang: string | null = null;
  private cancelAllPending: Set<() => void> = new Set();

  /** Load engine + cache voices. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await Tts.getInitStatus();
      this.initialized = true;
      await this.cacheVoices();
      Tts.setDefaultRate(SPEECH_RATE);
    } catch (e: unknown) {
      console.warn('[NativeTTSService] TTS init failed:', e instanceof Error ? e.message : String(e));
    }
  }

  private async cacheVoices(): Promise<void> {
    try {
      const voices = await Tts.voices();
      for (const v of voices) {
        if (v.notInstalled) continue;
        const lang = v.language.split(/[-_]/)[0].toLowerCase();
        if (!this.voicesByLang.has(lang)) {
          this.voicesByLang.set(lang, { id: v.id, language: v.language });
        }
      }
    } catch {
      /* voices() not available — fall back to setDefaultLanguage path */
    }
  }

  /** Apply the voice/language for the next utterance. Cached per language. */
  private async applyLanguage(language: string): Promise<void> {
    const baseLang = language.split(/[-_]/)[0].toLowerCase();
    if (this.currentLang === baseLang) return;
    const cached = this.voicesByLang.get(baseLang);
    if (cached) {
      try {
        await Tts.setDefaultVoice(cached.id);
        this.currentLang = baseLang;
        return;
      } catch {
        /* fall through to language fallback */
      }
    }
    const locale = toTtsLocale(baseLang);
    try {
      await Tts.setDefaultLanguage(locale);
      this.currentLang = baseLang;
    } catch {
      try { await Tts.setDefaultLanguage(language); } catch { /* unsupported */ }
    }
  }

  /**
   * Speculative warmup — load the voice engine for `language` so the first
   * real sentence's TTS first-audio-frame latency drops by ~100-300 ms on
   * Android. Speaks a single space character (inaudible) and does not await.
   */
  prewarm(language: string): void {
    void (async () => {
      if (!this.initialized) await this.init();
      await this.applyLanguage(language);
      try {
        // Returns a Promise<utteranceId> — fire and forget.
        void Tts.speak(' ');
      } catch {
        /* best-effort */
      }
    })();
  }

  /**
   * Speak `text` in `language`. Resolves when this specific utterance
   * finishes (tts-finish with the matching utteranceId), is cancelled, or
   * errors. Multiple consecutive calls queue in order — react-native-tts
   * native engine handles the queuing.
   */
  async speakChunk(text: string, language: string): Promise<void> {
    if (!text.trim()) return;
    if (!this.initialized) await this.init();
    await this.applyLanguage(language);

    // Tts.speak() resolves to the utteranceId once accepted by the native
    // engine. We then await its tts-finish/tts-cancel/tts-error event.
    let utteranceId: string | number;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      utteranceId = (await (Tts as any).speak(text)) as string | number;
    } catch (e) {
      console.warn('[NativeTTSService] speak() rejected:', e);
      return;
    }

    return new Promise<void>((resolve) => {
      let done = false;
      let playbackTimer: ReturnType<typeof setTimeout> | null = null;
      let startSub: { remove?(): void } | null = null;
      let finishSub: { remove?(): void } | null = null;
      let cancelSub: { remove?(): void } | null = null;
      let errorSub: { remove?(): void } | null = null;

      const finish = () => {
        if (done) return;
        done = true;
        startSub?.remove?.();
        finishSub?.remove?.();
        cancelSub?.remove?.();
        errorSub?.remove?.();
        if (playbackTimer) clearTimeout(playbackTimer);
        clearTimeout(enqueueTimer);
        this.cancelAllPending.delete(forceCancel);
        resolve();
      };
      const forceCancel = () => finish();
      this.cancelAllPending.add(forceCancel);

      // Pre-playback fallback. Fires only if `tts-start` never arrives —
      // the chunk got dropped or the engine is stuck before producing any
      // audio for it. Generous enough to wait through a deep queue of
      // preceding chunks playing first.
      const enqueueTimer = setTimeout(finish, ENQUEUE_TIMEOUT_MS);

      const matches = (ev: unknown): boolean => {
        const id = (ev as { utteranceId?: unknown })?.utteranceId;
        return id === utteranceId || id === String(utteranceId);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startSub = Tts.addEventListener('tts-start', (ev: any) => {
        if (!matches(ev)) return;
        // Playback for THIS chunk just began. Arm the playback cap from
        // here so the timer measures actual audio time, not queue wait.
        if (playbackTimer) clearTimeout(playbackTimer);
        playbackTimer = setTimeout(finish, PLAYBACK_TIMEOUT_MS);
      }) as unknown as { remove?(): void };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finishSub = Tts.addEventListener('tts-finish', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cancelSub = Tts.addEventListener('tts-cancel', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errorSub = Tts.addEventListener('tts-error', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
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

/** BCP-47 locale fallback for short language codes. */
function toTtsLocale(lang: string): string {
  if (lang.includes('-') || lang.includes('_')) return lang;
  const map: Record<string, string> = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
    pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', ru: 'ru-RU', ja: 'ja-JP',
    ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR',
    sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', no: 'nb-NO', el: 'el-GR',
    cs: 'cs-CZ', ro: 'ro-RO', hu: 'hu-HU', uk: 'uk-UA', th: 'th-TH',
    vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', ca: 'ca-ES', he: 'he-IL',
    bg: 'bg-BG', hr: 'hr-HR', sk: 'sk-SK', sl: 'sl-SI', bn: 'bn-IN',
    ur: 'ur-PK', fa: 'fa-IR', sw: 'sw-TZ',
  };
  return map[lang] ?? lang;
}
