// CanaryService — dual-engine NeMo Canary 180M Flash for auto-detect VAD mode.
//
// Key property: Canary with srcLang=tgtLang NEVER translates — it only transcribes.
// Running two instances (one per language) in parallel eliminates Whisper's
// auto-translation bug at the cost of ~2x RAM for the STT component.
//
// Only supports the Canary language set: en, es, de, fr.
// Other pairs fall back to WhisperService (see PipelineOrchestrator).

import { createSTT } from 'react-native-sherpa-onnx/stt';
import type { SttEngine } from 'react-native-sherpa-onnx/stt';
import { Platform } from 'react-native';

const CANARY_LANG_SET = new Set(['en', 'es', 'de', 'fr']);
const STT_THREADS = 4;

/** Normalised language code from any BCP-47 variant (e.g. "en-US" → "en"). */
function norm(lang: string): string {
  return lang.split('-')[0].split('_')[0].toLowerCase();
}

async function resolveProvider(): Promise<string> {
  if (Platform.OS !== 'android') return 'cpu';
  try {
    const { getNnapiSupport } = await import('react-native-sherpa-onnx');
    const support = await getNnapiSupport();
    return support.canInit ? 'nnapi' : 'cpu';
  } catch {
    return 'cpu';
  }
}

export interface CanaryDualResult {
  /** Transcript from engine configured for langA. */
  readonly textA: string;
  /** Transcript from engine configured for langB. */
  readonly textB: string;
  /** Normalised language code for engine A. */
  readonly langA: string;
  /** Normalised language code for engine B. */
  readonly langB: string;
}

export class CanaryService {
  private engineA: SttEngine | null = null;
  private engineB: SttEngine | null = null;
  private loadedLangA: string | null = null;
  private loadedLangB: string | null = null;

  /** True when both languages of the pair are in the Canary language set. */
  static supportsLanguagePair(langA: string, langB: string): boolean {
    const a = norm(langA);
    const b = norm(langB);
    return a !== b && CANARY_LANG_SET.has(a) && CANARY_LANG_SET.has(b);
  }

  get isReady(): boolean {
    return this.engineA !== null && this.engineB !== null;
  }

  /**
   * Load two Canary engine instances — one per language.
   * Existing engines are released before re-loading (safe to call on language change).
   */
  async load(modelDir: string, langA: string, langB: string): Promise<void> {
    const provider = await resolveProvider();
    const a = norm(langA);
    const b = norm(langB);

    // Release any existing engines before creating new ones
    await this.releaseEngines();

    const [engineA, engineB] = await Promise.all([
      createSTT({
        modelPath: { type: 'file', path: modelDir },
        modelType: 'canary',
        numThreads: STT_THREADS,
        provider,
        modelOptions: { canary: { srcLang: a, tgtLang: a, usePnc: true } },
      }),
      createSTT({
        modelPath: { type: 'file', path: modelDir },
        modelType: 'canary',
        numThreads: STT_THREADS,
        provider,
        modelOptions: { canary: { srcLang: b, tgtLang: b, usePnc: true } },
      }),
    ]);

    this.engineA = engineA;
    this.engineB = engineB;
    this.loadedLangA = a;
    this.loadedLangB = b;
  }

  /**
   * Transcribe the same audio file with both engines in parallel.
   * Returns both transcripts so the caller can pick the correct one via ML Kit.
   */
  async transcribeBoth(audioPath: string): Promise<CanaryDualResult | null> {
    if (!this.engineA || !this.engineB || !this.loadedLangA || !this.loadedLangB) {
      return null;
    }

    const [rA, rB] = await Promise.all([
      this.engineA.transcribeFile(audioPath),
      this.engineB.transcribeFile(audioPath),
    ]);

    return {
      textA: rA.text.trim(),
      textB: rB.text.trim(),
      langA: this.loadedLangA,
      langB: this.loadedLangB,
    };
  }

  async release(): Promise<void> {
    await this.releaseEngines();
  }

  private async releaseEngines(): Promise<void> {
    await Promise.all([
      this.engineA?.destroy().catch(() => {}),
      this.engineB?.destroy().catch(() => {}),
    ]);
    this.engineA = null;
    this.engineB = null;
    this.loadedLangA = null;
    this.loadedLangB = null;
  }
}

export const canaryService = new CanaryService();
