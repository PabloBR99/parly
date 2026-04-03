import { NativeModules } from 'react-native';
import type { TranslationResult } from '../../app/types';
import type { ITranslationService } from './TranslationService';

// Native module bridging Google ML Kit Translation
// Implementation in android/.../translation/TranslationModule.kt
const { LinguaFaceTranslation } = NativeModules;

class AndroidTranslationService implements ITranslationService {
  async translate(text: string, from: string, to: string): Promise<TranslationResult> {
    if (!LinguaFaceTranslation) {
      throw new Error('[TranslationService.android] Native module not available');
    }
    const result: string = await LinguaFaceTranslation.translate(text, from, to);
    return { text: result };
  }

  async isLanguagePairReady(from: string, to: string): Promise<boolean> {
    if (!LinguaFaceTranslation) return false;
    return LinguaFaceTranslation.isModelDownloaded(from, to);
  }

  async downloadLanguagePair(from: string, to: string): Promise<void> {
    if (!LinguaFaceTranslation) return;
    await LinguaFaceTranslation.downloadModel(from, to);
  }
}

export default new AndroidTranslationService();
