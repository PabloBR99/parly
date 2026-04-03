import Tts from 'react-native-tts';
import type { VoiceId } from '../../app/types';

const SPEECH_RATE = 0.5;

interface CachedVoice {
  readonly id: string;
  readonly language: string;
}

class NativeTTSService {
  private initialized = false;
  private activeCleanup: (() => void) | null = null;
  private voicesByLang = new Map<string, CachedVoice>();

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await Tts.getInitStatus();
      this.initialized = true;
      await this.cacheVoices();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[NativeTTSService] TTS init failed:', msg);
    }
  }

  private async cacheVoices(): Promise<void> {
    try {
      const voices = await Tts.voices();
      for (const v of voices) {
        if (v.notInstalled) continue;
        const lang = v.language.split('-')[0].split('_')[0].toLowerCase();
        // Keep the first (highest-quality) voice per language
        if (!this.voicesByLang.has(lang)) {
          this.voicesByLang.set(lang, { id: v.id, language: v.language });
        }
      }
    } catch {
      // voices() not available — fall back to setDefaultLanguage path
    }
  }

  async speak(text: string, language: string, _voice: VoiceId): Promise<void> {
    if (!this.initialized) await this.init();

    const baseLang = language.split('-')[0].split('_')[0].toLowerCase();

    // Prefer explicit voice selection — more reliable than setDefaultLanguage
    const cached = this.voicesByLang.get(baseLang);
    if (cached) {
      try {
        await Tts.setDefaultVoice(cached.id);
      } catch {
        // Voice selection failed — fall through to setDefaultLanguage
        await this.setLanguageFallback(language);
      }
    } else {
      await this.setLanguageFallback(language);
    }

    Tts.setDefaultRate(SPEECH_RATE);

    console.warn(`[TTS-DEBUG] speak() text="${text}" lang="${language}"`);

    return new Promise((resolve) => {
      let resolved = false;
      const done = (reason: string) => {
        if (resolved) return;
        resolved = true;
        console.warn(`[TTS-DEBUG] speak() resolved via ${reason}`);
        finishSub?.remove();
        errorSub?.remove();
        clearTimeout(timer);
        this.activeCleanup = null;
        resolve();
      };
      let finishSub: { remove(): void } | undefined;
      let errorSub: { remove(): void } | undefined;
      // 8s hard cap — short enough to not freeze the pipeline
      const timer = setTimeout(() => done('timeout'), 8_000);
      finishSub = Tts.addEventListener('tts-finish', () => done('tts-finish')) as unknown as { remove(): void };
      errorSub  = Tts.addEventListener('tts-error',  () => done('tts-error')) as unknown as { remove(): void };
      this.activeCleanup = () => done('stop()');
      Tts.speak(text);
    });
  }

  stop(): void {
    Tts.stop();
    if (this.activeCleanup) {
      this.activeCleanup();
    }
  }

  private async setLanguageFallback(language: string): Promise<void> {
    const locale = toTtsLocale(language);
    try {
      await Tts.setDefaultLanguage(locale);
    } catch {
      try { await Tts.setDefaultLanguage(language); } catch { /* unsupported */ }
    }
  }
}

export const nativeTTSService = new NativeTTSService();

/** Convert short language code to full BCP-47 locale for Android TTS engines. */
function toTtsLocale(lang: string): string {
  if (lang.includes('-') || lang.includes('_')) return lang; // already has region
  const map: Record<string, string> = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
    pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', ru: 'ru-RU', ja: 'ja-JP',
    ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR',
    sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', no: 'nb-NO', el: 'el-GR',
    cs: 'cs-CZ', ro: 'ro-RO', hu: 'hu-HU', uk: 'uk-UA', th: 'th-TH',
    vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', ca: 'ca-ES', he: 'he-IL',
    bg: 'bg-BG', hr: 'hr-HR', sk: 'sk-SK', sl: 'sl-SI',
  };
  return map[lang] ?? lang;
}
