import type { Language } from './types';

// Languages supported by Voxtral TTS (and used for UI localization)
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English',    flag: '🇬🇧' },
  { code: 'es', name: 'Español',    flag: '🇪🇸' },
  { code: 'fr', name: 'Français',   flag: '🇫🇷' },
  { code: 'de', name: 'Deutsch',    flag: '🇩🇪' },
  { code: 'it', name: 'Italiano',   flag: '🇮🇹' },
  { code: 'pt', name: 'Português',  flag: '🇵🇹' },
  { code: 'nl', name: 'Nederlands', flag: '🇳🇱' },
  { code: 'ar', name: 'العربية',    flag: '🇸🇦' },
  { code: 'hi', name: 'हिन्दी',      flag: '🇮🇳' },
];

export function getLanguage(code: string): Language {
  return (
    LANGUAGES.find(l => l.code === code) ?? {
      code,
      name: code.toUpperCase(),
      flag: '🌐',
    }
  );
}
