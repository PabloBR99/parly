import type { Language } from './types';

/**
 * Languages offered for diplomatic conversations. Includes the major UN
 * languages plus high-traffic European, Asian, and Middle Eastern picks.
 *
 * `name` is the English label (used for accessibility and as fallback).
 * `endonym` is how speakers of that language write its name themselves.
 * `emoji` is a representative glyph (flag where culturally safe, script
 * otherwise).
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English',     endonym: 'English',     emoji: '🇬🇧' },
  { code: 'es', name: 'Spanish',     endonym: 'Español',     emoji: '🇪🇸' },
  { code: 'fr', name: 'French',      endonym: 'Français',    emoji: '🇫🇷' },
  { code: 'de', name: 'German',      endonym: 'Deutsch',     emoji: '🇩🇪' },
  { code: 'it', name: 'Italian',     endonym: 'Italiano',    emoji: '🇮🇹' },
  { code: 'pt', name: 'Portuguese',  endonym: 'Português',   emoji: '🇵🇹' },
  { code: 'nl', name: 'Dutch',       endonym: 'Nederlands',  emoji: '🇳🇱' },
  { code: 'ru', name: 'Russian',     endonym: 'Русский',     emoji: '🇷🇺' },
  { code: 'uk', name: 'Ukrainian',   endonym: 'Українська',  emoji: '🇺🇦' },
  { code: 'pl', name: 'Polish',      endonym: 'Polski',      emoji: '🇵🇱' },
  { code: 'cs', name: 'Czech',       endonym: 'Čeština',     emoji: '🇨🇿' },
  { code: 'el', name: 'Greek',       endonym: 'Ελληνικά',    emoji: '🇬🇷' },
  { code: 'tr', name: 'Turkish',     endonym: 'Türkçe',      emoji: '🇹🇷' },
  { code: 'ar', name: 'Arabic',      endonym: 'العربية',     emoji: '🌐' },
  { code: 'he', name: 'Hebrew',      endonym: 'עברית',       emoji: '🇮🇱' },
  { code: 'fa', name: 'Persian',     endonym: 'فارسی',       emoji: '🇮🇷' },
  { code: 'hi', name: 'Hindi',       endonym: 'हिन्दी',       emoji: '🇮🇳' },
  { code: 'bn', name: 'Bengali',     endonym: 'বাংলা',         emoji: '🇧🇩' },
  { code: 'ur', name: 'Urdu',        endonym: 'اُردُو',        emoji: '🇵🇰' },
  { code: 'zh', name: 'Chinese',     endonym: '中文',         emoji: '🇨🇳' },
  { code: 'ja', name: 'Japanese',    endonym: '日本語',        emoji: '🇯🇵' },
  { code: 'ko', name: 'Korean',      endonym: '한국어',        emoji: '🇰🇷' },
  { code: 'vi', name: 'Vietnamese',  endonym: 'Tiếng Việt',  emoji: '🇻🇳' },
  { code: 'th', name: 'Thai',        endonym: 'ไทย',          emoji: '🇹🇭' },
  { code: 'id', name: 'Indonesian',  endonym: 'Indonesia',   emoji: '🇮🇩' },
  { code: 'sv', name: 'Swedish',     endonym: 'Svenska',     emoji: '🇸🇪' },
  { code: 'no', name: 'Norwegian',   endonym: 'Norsk',       emoji: '🇳🇴' },
  { code: 'da', name: 'Danish',      endonym: 'Dansk',       emoji: '🇩🇰' },
  { code: 'fi', name: 'Finnish',     endonym: 'Suomi',       emoji: '🇫🇮' },
  { code: 'ro', name: 'Romanian',    endonym: 'Română',      emoji: '🇷🇴' },
  { code: 'hu', name: 'Hungarian',   endonym: 'Magyar',      emoji: '🇭🇺' },
  { code: 'sw', name: 'Swahili',     endonym: 'Kiswahili',   emoji: '🇹🇿' },
];

export function getLanguage(code: string): Language {
  return (
    LANGUAGES.find(l => l.code === code) ?? {
      code,
      name: code.toUpperCase(),
      endonym: code.toUpperCase(),
      emoji: '🌐',
    }
  );
}
