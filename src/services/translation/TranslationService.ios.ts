import { NativeModules } from 'react-native';
import type { TranslationResult } from '../../app/types';
import type { ITranslationService } from './TranslationService';

// Native module bridging Apple's Translation framework (iOS 17.4+)
// Implementation in ios/Parly/Translation/TranslationBridge.swift
const { ParlyTranslation } = NativeModules;

class IOSTranslationService implements ITranslationService {
  async translate(text: string, from: string, to: string): Promise<TranslationResult> {
    if (!ParlyTranslation) {
      throw new Error('[TranslationService.ios] Native module not available');
    }
    const result: string = await ParlyTranslation.translate(text, from, to);
    return { text: result };
  }

  async isLanguagePairReady(from: string, to: string): Promise<boolean> {
    if (!ParlyTranslation) return false;
    return ParlyTranslation.isLanguagePairAvailable(from, to);
  }

  async downloadLanguagePair(_from: string, _to: string): Promise<void> {
    // iOS Translation framework handles downloads automatically
  }
}

export default new IOSTranslationService();
