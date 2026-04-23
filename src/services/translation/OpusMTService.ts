// OpusMTService — On-device MarianMT ONNX translation via native OpusMTModule.
//
// Implements ITranslationService. Uses direct models for EN↔{ES,FR,DE} pairs
// and EN pivot for non-EN pairs (e.g., es→fr = es→en + en→fr).
//
// Language identification is delegated to ML Kit (tiny dependency, no models to manage).
// Model loading is lazy — loadModel() is called on first translate() for a pair.

import { NativeModules } from 'react-native';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import type { TranslationResult } from '../../app/types';
import type { ITranslationService, LanguageCandidate } from './TranslationService';
import { findDirectModel, getRequiredModels, getPivotModels } from './OpusMTModels';
import type { OpusMTModelInfo } from './OpusMTModels';

const { ParlyOpusMT, ParlyTranslation } = NativeModules;

/** Base directory for all OpusMT model files. */
const OPUS_MT_BASE_DIR = `${DocumentDirectoryPath}/opus-mt`;

function modelDirPath(model: OpusMTModelInfo): string {
  return `${OPUS_MT_BASE_DIR}/${model.dirName}`;
}

class OpusMTService implements ITranslationService {
  /** Track which model dirs have been loaded into native ONNX sessions. */
  private readonly loadedModels = new Set<string>();
  /** In-flight load promises to prevent double-loading. */
  private readonly loadingPromises = new Map<string, Promise<void>>();

  // ── ITranslationService ───────────────────────────────────────────────

  async translate(text: string, from: string, to: string): Promise<TranslationResult> {
    if (!ParlyOpusMT) {
      throw new Error('[OpusMTService] Native module not available');
    }

    const src = from.split('-')[0].toLowerCase();
    const tgt = to.split('-')[0].toLowerCase();

    if (src === tgt) {
      return { text }; // Same language — passthrough
    }

    // Direct model?
    const direct = findDirectModel(src, tgt);
    if (direct) {
      await this.ensureLoaded(direct);
      const result: string = await ParlyOpusMT.translate(text, modelDirPath(direct));
      return { text: result };
    }

    // Pivot through English
    const pivot = getPivotModels(src, tgt);
    if (pivot) {
      const [srcToEn, enToTgt] = pivot;
      await Promise.all([this.ensureLoaded(srcToEn), this.ensureLoaded(enToTgt)]);
      const intermediate: string = await ParlyOpusMT.translate(text, modelDirPath(srcToEn));
      const result: string = await ParlyOpusMT.translate(intermediate, modelDirPath(enToTgt));
      return { text: result };
    }

    throw new Error(`[OpusMTService] Unsupported language pair: ${src} → ${tgt}`);
  }

  async isLanguagePairReady(from: string, to: string): Promise<boolean> {
    const models = getRequiredModels(from, to);
    if (models.length === 0) return false;

    for (const model of models) {
      const dir = modelDirPath(model);
      const loaded = this.loadedModels.has(dir);
      if (loaded) continue;

      // Check if native module has it loaded
      if (ParlyOpusMT) {
        const nativeLoaded: boolean = await ParlyOpusMT.isModelLoaded(dir);
        if (nativeLoaded) {
          this.loadedModels.add(dir);
          continue;
        }
      }
      return false;
    }
    return true;
  }

  async downloadLanguagePair(from: string, to: string): Promise<void> {
    // Download is handled by ModelManager — this is a no-op.
    // The OpusMT models are downloaded during init, not on-demand via this method.
    // This method exists to satisfy the interface.
  }

  async identifyLanguage(text: string): Promise<readonly LanguageCandidate[]> {
    // Delegate to ML Kit — it's tiny and works well for language ID
    if (!ParlyTranslation?.identifyLanguage) return [];
    const results: Array<{ language: string; confidence: number }> =
      await ParlyTranslation.identifyLanguage(text);
    return results;
  }

  // ── Model lifecycle ───────────────────────────────────────────────────

  /**
   * Load a model into the native ONNX session if not already loaded.
   * Safe for concurrent calls — deduplicates via loadingPromises.
   */
  private async ensureLoaded(model: OpusMTModelInfo): Promise<void> {
    const dir = modelDirPath(model);

    if (this.loadedModels.has(dir)) return;

    // Deduplicate concurrent loads
    const existing = this.loadingPromises.get(dir);
    if (existing) {
      await existing;
      return;
    }

    const loadPromise = (async () => {
      try {
        await ParlyOpusMT.loadModel(dir);
        this.loadedModels.add(dir);
        console.log(`[OpusMTService] Loaded ${model.dirName}`);
      } finally {
        this.loadingPromises.delete(dir);
      }
    })();

    this.loadingPromises.set(dir, loadPromise);
    await loadPromise;
  }

  /**
   * Release a specific model's ONNX session to free memory.
   */
  async releaseModel(model: OpusMTModelInfo): Promise<void> {
    const dir = modelDirPath(model);
    this.loadedModels.delete(dir);
    if (ParlyOpusMT) {
      await ParlyOpusMT.releaseModel(dir);
    }
  }

  /**
   * Release all loaded ONNX sessions.
   */
  async releaseAll(): Promise<void> {
    this.loadedModels.clear();
    this.loadingPromises.clear();
    if (ParlyOpusMT) {
      await ParlyOpusMT.releaseAll();
    }
  }
}

export const opusMTService = new OpusMTService();
export default opusMTService;
