import { createSTT } from 'react-native-sherpa-onnx/stt';
import type { SttEngine } from 'react-native-sherpa-onnx/stt';
import { Platform } from 'react-native';
import type { TranscriptionResult } from '../../app/types';

const STT_THREADS = 4;

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

export class WhisperService {
  private engine: SttEngine | null = null;

  async load(modelDir: string): Promise<void> {
    const provider = await resolveProvider();
    this.engine = await createSTT({
      modelPath: { type: 'file', path: modelDir },
      modelType: 'whisper',
      numThreads: STT_THREADS,
      provider,
      modelOptions: {
        whisper: { task: 'transcribe' }, // no language → auto-detect
      },
    });
  }

  get isReady(): boolean {
    return this.engine !== null;
  }

  async transcribe(audioPath: string, _language?: string): Promise<TranscriptionResult> {
    if (!this.engine) throw new Error('[WhisperService] Model not loaded');

    const result = await this.engine.transcribeFile(audioPath);

    return {
      text: result.text.trim(),
      language: result.lang || _language || 'auto',
    };
  }

  async release(): Promise<void> {
    await this.engine?.destroy();
    this.engine = null;
  }
}

export const whisperService = new WhisperService();
