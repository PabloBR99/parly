import Tts from 'react-native-tts';
import type { VoiceId } from '../../app/types';

const SPEECH_RATE = 0.5;

class NativeTTSService {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await Tts.getInitStatus();
      this.initialized = true;
    } catch (e: unknown) {
      // Some Android devices require a TTS engine to be installed
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[NativeTTSService] TTS init failed:', msg);
    }
  }

  async speak(text: string, language: string, _voice: VoiceId): Promise<void> {
    if (!this.initialized) await this.init();

    // Many Android devices reject bare codes ('en') but accept locale codes ('en-US')
    const locale = toTtsLocale(language);
    try {
      await Tts.setDefaultLanguage(locale);
    } catch {
      // Try bare code as last resort
      try { await Tts.setDefaultLanguage(language); } catch { /* unsupported */ }
    }
    Tts.setDefaultRate(SPEECH_RATE);

    return new Promise((resolve) => {
      // eslint-disable-next-line prefer-const
      let finishSub: { remove(): void } | undefined;
      // eslint-disable-next-line prefer-const
      let errorSub: { remove(): void } | undefined;
      const cleanup = () => {
        finishSub?.remove();
        errorSub?.remove();
        clearTimeout(timer);
      };
      const onFinish = () => { cleanup(); resolve(); };
      const onError  = () => { cleanup(); resolve(); }; // non-fatal — just proceed
      // 30s hard cap in case the TTS engine never fires the event
      const timer = setTimeout(() => { cleanup(); resolve(); }, 30_000);
      finishSub = Tts.addEventListener('tts-finish', onFinish) as unknown as { remove(): void };
      errorSub  = Tts.addEventListener('tts-error',  onError) as unknown as { remove(): void };
      Tts.speak(text);
    });
  }

  stop(): void {
    Tts.stop();
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
