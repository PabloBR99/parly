import { NativeModules } from 'react-native';
import type { TranslationResult } from '../../app/types';
import type { ITranslationService } from './TranslationService';

// Native module bridging Google ML Kit Translation
// Implementation in android/.../translation/TranslationModule.kt
const { ParlyTranslation } = NativeModules;

class AndroidTranslationService implements ITranslationService {
  async translate(text: string, from: string, to: string): Promise<TranslationResult> {
    if (!ParlyTranslation) {
      throw new Error('[TranslationService.android] Native module not available');
    }
    const result: string = await ParlyTranslation.translate(text, from, to);
    return { text: result };
  }

  async isLanguagePairReady(from: string, to: string): Promise<boolean> {
    if (!ParlyTranslation) return false;
    return ParlyTranslation.isModelDownloaded(from, to);
  }

  async downloadLanguagePair(from: string, to: string): Promise<void> {
    if (!ParlyTranslation) return;
    await ParlyTranslation.downloadModel(from, to);
  }
}

export default new AndroidTranslationService();
