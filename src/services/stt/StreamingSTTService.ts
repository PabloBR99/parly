// StreamingSTTService — wraps sherpa-onnx OnlineRecognizer for real-time
// streaming ASR using per-language Kroko Zipformer2 transducer models.

import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import type {
  StreamingSttEngine,
  SttStream,
  StreamingSttResult,
} from 'react-native-sherpa-onnx/stt';
import { Platform } from 'react-native';

const STT_THREADS = 2; // lower than offline — runs continuously during speech

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

/** Languages supported by the Kroko streaming model collection. */
export const KROKO_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'tr'] as const;
export type KrokoLanguage = (typeof KROKO_LANGUAGES)[number];

export function isKrokoLanguage(lang: string): lang is KrokoLanguage {
  return (KROKO_LANGUAGES as readonly string[]).includes(lang.split('-')[0].toLowerCase());
}

export interface StreamingPartialResult {
  readonly text: string;
  readonly tokens: string[];
  readonly isEndpoint: boolean;
}

class StreamingSTTService {
  private readonly engines = new Map<string, StreamingSttEngine>();
  private modelBaseDir = '';

  setModelBaseDir(dir: string): void {
    this.modelBaseDir = dir;
  }

  /** Load (or reuse) the streaming engine for a specific language. */
  async loadEngine(lang: string): Promise<void> {
    const normalized = lang.split('-')[0].toLowerCase();
    if (this.engines.has(normalized)) return;
    if (!this.modelBaseDir) throw new Error('[StreamingSTT] Model base dir not set');

    const modelDir = `${this.modelBaseDir}/${normalized}`;
    const provider = await resolveProvider();

    const engine = await createStreamingSTT({
      modelPath: { type: 'file', path: modelDir },
      modelType: 'transducer',
      numThreads: STT_THREADS,
      provider,
      enableEndpoint: true,
      endpointConfig: {
        // Tighter endpoint rules for conversational speech:
        // Rule 1: 1.8s silence without any speech → endpoint (background noise)
        rule1: { mustContainNonSilence: false, minTrailingSilence: 1.8, minUtteranceLength: 0 },
        // Rule 2: 1.0s silence after speech → endpoint (natural pause)
        rule2: { mustContainNonSilence: true, minTrailingSilence: 1.0, minUtteranceLength: 0 },
        // Rule 3: 15s max utterance
        rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 15 },
      },
      decodingMethod: 'greedy_search',
    });

    this.engines.set(normalized, engine);
    console.log(`[StreamingSTT] Engine loaded for "${normalized}"`);
  }

  /** Create a new stream for an utterance in the given language. */
  async createStream(lang: string): Promise<SttStream> {
    const normalized = lang.split('-')[0].toLowerCase();
    const engine = this.engines.get(normalized);
    if (!engine) throw new Error(`[StreamingSTT] No engine loaded for "${normalized}"`);
    return engine.createStream();
  }

  /**
   * Feed a PCM audio chunk to the stream and return partial results.
   * Uses the convenience method that reduces bridge round-trips.
   * @param stream - Active SttStream
   * @param samples - Float32 PCM samples in [-1, 1]
   * @param sampleRate - Sample rate (16000)
   */
  async feedAudio(
    stream: SttStream,
    samples: number[] | Float32Array,
    sampleRate: number,
  ): Promise<StreamingPartialResult> {
    const { result, isEndpoint } = await stream.processAudioChunk(samples, sampleRate);
    return {
      text: result.text,
      tokens: result.tokens,
      isEndpoint,
    };
  }

  /** Signal end of audio input and get final result. */
  async finalize(stream: SttStream): Promise<StreamingSttResult> {
    await stream.inputFinished();
    // Decode any remaining audio
    if (await stream.isReady()) {
      await stream.decode();
    }
    const result = await stream.getResult();
    await stream.release();
    return result;
  }

  /** Release a stream without finalizing (e.g., on cancel). */
  async releaseStream(stream: SttStream): Promise<void> {
    await stream.release().catch(() => {});
  }

  /** Check if a language engine is loaded and ready. */
  isLoaded(lang: string): boolean {
    return this.engines.has(lang.split('-')[0].toLowerCase());
  }

  /** Release all engines. */
  async release(): Promise<void> {
    const destroys = Array.from(this.engines.values()).map(e => e.destroy().catch(() => {}));
    await Promise.all(destroys);
    this.engines.clear();
    console.log('[StreamingSTT] All engines released');
  }

  /** Release a specific language engine. */
  async releaseEngine(lang: string): Promise<void> {
    const normalized = lang.split('-')[0].toLowerCase();
    const engine = this.engines.get(normalized);
    if (engine) {
      await engine.destroy().catch(() => {});
      this.engines.delete(normalized);
    }
  }
}

export const streamingSTTService = new StreamingSTTService();
