// AudioLIDService — Silero ONNX-based spoken language identification.
//
// Wraps the native ParlySileroLID module (Kotlin) which runs the Silero
// lang_classifier_95.onnx model via ONNX Runtime Java API. Identifies the
// spoken language directly from audio PCM — immune to Whisper's translate bug.
//
// Key improvement over ML Kit text LID:
//   - Operates on raw audio, not transcribed text
//   - Correctly identifies Spanish audio even when Whisper outputs English text
//   - 95 languages supported, 17MB model

import { NativeModules } from 'react-native';

const ParlySileroLID = NativeModules.ParlySileroLID;

export interface LIDPrediction {
  readonly language: string;
  readonly confidence: number;
}

class AudioLIDService {
  private initialized = false;

  async load(modelPath: string, langDictPath: string): Promise<void> {
    if (!ParlySileroLID) {
      console.warn('[AudioLID] Native module not available');
      return;
    }
    try {
      await ParlySileroLID.initialize(modelPath, langDictPath);
      this.initialized = true;
      console.log('[AudioLID] Model loaded');
    } catch (e) {
      console.error('[AudioLID] Failed to load:', e);
      this.initialized = false;
    }
  }

  get isLoaded(): boolean {
    return this.initialized;
  }

  /**
   * Identify language from raw PCM audio samples.
   * @param samples Float32 PCM at 16kHz, normalized to [-1, 1]
   * @param topN Number of top predictions to return
   */
  async identifyLanguage(samples: number[], topN = 3): Promise<LIDPrediction[]> {
    if (!this.initialized || !ParlySileroLID) return [];
    try {
      return await ParlySileroLID.identifyLanguage(samples, topN);
    } catch (e) {
      console.error('[AudioLID] Inference error:', e);
      return [];
    }
  }

  /**
   * Identify language from a 16kHz mono PCM16 WAV file.
   * More efficient than decoding + passing samples over the bridge.
   */
  async identifyLanguageFromFile(wavPath: string, topN = 3): Promise<LIDPrediction[]> {
    if (!this.initialized || !ParlySileroLID) return [];
    try {
      return await ParlySileroLID.identifyLanguageFromFile(wavPath, topN);
    } catch (e) {
      console.error('[AudioLID] File inference error:', e);
      return [];
    }
  }

  async release(): Promise<void> {
    this.initialized = false;
    if (ParlySileroLID) {
      await ParlySileroLID.release().catch(() => {});
    }
  }
}

export const audioLIDService = new AudioLIDService();
