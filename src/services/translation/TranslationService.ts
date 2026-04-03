import type { TranslationResult } from '../../app/types';

export interface ITranslationService {
  translate(text: string, from: string, to: string): Promise<TranslationResult>;
  isLanguagePairReady(from: string, to: string): Promise<boolean>;
  downloadLanguagePair(from: string, to: string): Promise<void>;
}
