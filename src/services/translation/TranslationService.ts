import type { TranslationResult } from '../../app/types';

export interface LanguageCandidate {
  readonly language: string;
  readonly confidence: number;
}

export interface ITranslationService {
  translate(text: string, from: string, to: string): Promise<TranslationResult>;
  isLanguagePairReady(from: string, to: string): Promise<boolean>;
  downloadLanguagePair(from: string, to: string): Promise<void>;
  identifyLanguage(text: string): Promise<readonly LanguageCandidate[]>;
}
