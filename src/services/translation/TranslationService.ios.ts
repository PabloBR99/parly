import { NativeModules } from 'react-native';
import type { TranslationResult } from '../../app/types';
import type { ITranslationService } from './TranslationService';

// Native module bridging Apple's Translation framework (iOS 17.4+)
// Implementation in ios/LinguaFace/Translation/TranslationBridge.swift
const { LinguaFaceTranslation } = NativeModules;

class IOSTranslationService implements ITranslationService {
  async translate(text: string, from: string, to: string): Promise<TranslationResult> {
    if (!LinguaFaceTranslation) {
      throw new Error('[TranslationService.ios] Native module not available');
    }
    const result: string = await LinguaFaceTranslation.translate(text, from, to);
    return { text: result };
  }

  async isLanguagePairReady(from: string, to: string): Promise<boolean> {
    if (!LinguaFaceTranslation) return false;
    return LinguaFaceTranslation.isLanguagePairAvailable(from, to);
  }

  async downloadLanguagePair(_from: string, _to: string): Promise<void> {
    // iOS Translation framework handles downloads automatically
  }
}

export default new IOSTranslationService();
