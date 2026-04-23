import { Platform } from 'react-native';
import type { ITranslationService } from './TranslationService';
import { useModelStore } from '../../store/modelStore';

let _instance: ITranslationService | null = null;

export async function getTranslationService(): Promise<ITranslationService> {
  if (_instance) return _instance;
  if (Platform.OS === 'ios') {
    _instance = (await import('./TranslationService.ios')).default;
  } else {
    // Prefer OpusMT (on-device ONNX) when models are downloaded, fall back to ML Kit
    const opusMTReady = useModelStore.getState().opusMTStatus === 'ready';
    if (opusMTReady) {
      _instance = (await import('./OpusMTService')).default;
    } else {
      _instance = (await import('./TranslationService.android')).default;
    }
  }
  return _instance;
}

/**
 * Reset the cached instance — call when OpusMT models finish downloading
 * so the next getTranslationService() picks up the OpusMT service.
 *
 * SAFETY: Only call during init or when no utterance is in flight.
 * ReTranslator and WaitKTranslator call getTranslationService() per-partial,
 * so a mid-utterance reset would switch backends mid-sentence.
 */
export function resetTranslationService(): void {
  _instance = null;
}
