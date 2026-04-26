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
// Why a max timeout per chunk?
//   Some Android devices stall on missing voices or audio routing changes.
//   A 15s cap keeps the orchestrator unblocked.

import Tts from 'react-native-tts';

const SPEECH_RATE = 0.5;
const MAX_CHUNK_TIMEOUT_MS = 15_000;

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
      const finish = () => {
        if (done) return;
        done = true;
        finishSub?.remove?.();
        cancelSub?.remove?.();
        errorSub?.remove?.();
        clearTimeout(timer);
        this.cancelAllPending.delete(forceCancel);
        resolve();
      };
      const forceCancel = () => finish();
      this.cancelAllPending.add(forceCancel);
      const timer = setTimeout(finish, MAX_CHUNK_TIMEOUT_MS);
      const matches = (ev: unknown): boolean => {
        const id = (ev as { utteranceId?: unknown })?.utteranceId;
        return id === utteranceId || id === String(utteranceId);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finishSub = Tts.addEventListener('tts-finish', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cancelSub = Tts.addEventListener('tts-cancel', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSub = Tts.addEventListener('tts-error', (ev: any) => {
        if (matches(ev)) finish();
      }) as unknown as { remove?(): void };
    });
  }

  /**
   * Backward-compatible alias for the previous one-shot speak() callers.
   * Same as speakChunk() — keeps the existing imports happy until they
   * migrate.
   */
  async speak(text: string, language: string): Promise<void> {
    return this.speakChunk(text, language);
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
