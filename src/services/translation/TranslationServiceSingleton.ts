import { Platform } from 'react-native';
import type { ITranslationService } from './TranslationService';

let _instance: ITranslationService | null = null;

export async function getTranslationService(): Promise<ITranslationService> {
  if (_instance) return _instance;
  if (Platform.OS === 'ios') {
    _instance = (await import('./TranslationService.ios')).default;
  } else {
    _instance = (await import('./TranslationService.android')).default;
  }
  return _instance;
}
