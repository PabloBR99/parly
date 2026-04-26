/** Identifier for one of the two conversation participants. */
export type PersonId = 'person_a' | 'person_b';

/** A picker option in the language list. */
export interface Language {
  readonly code: string;     // BCP-47 short, e.g. 'es', 'en', 'zh', 'ar'
  readonly name: string;     // English name, e.g. 'Spanish'
  readonly endonym: string;  // native script, e.g. 'Español', '中文', 'العربية'
  readonly emoji: string;    // representative flag/script emoji
}
