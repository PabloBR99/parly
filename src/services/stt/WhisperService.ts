import { initWhisper, type WhisperContext } from 'whisper.rn';
import { Platform } from 'react-native';
import type { TranscriptionResult } from '../../app/types';

const WHISPER_THREADS = 4;

export class WhisperService {
  private context: WhisperContext | null = null;

  async load(modelPath: string): Promise<void> {
    this.context = await initWhisper({ filePath: modelPath });
  }

  get isReady(): boolean {
    return this.context !== null;
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptionResult> {
    if (!this.context) {
      throw new Error('[WhisperService] Model not loaded');
    }

    const { promise } = this.context.transcribe(audioPath, {
      language: language === 'auto' ? undefined : language,
      maxLen: 0,           // 0 = unlimited (was 1, which forced ~1 char/segment — massive overhead)
      tokenTimestamps: false,
      nThreads: WHISPER_THREADS,
      noContext: true,     // PTT utterances are independent — skip prior audio context
      useCoreML: Platform.OS === 'ios', // Apple Neural Engine acceleration on iPhone
    });

    const { result, language: detectedLang } = await promise;

    return {
      text: result.trim(),
      language: detectedLang ?? language ?? 'auto',
    };
  }

  async release(): Promise<void> {
    await this.context?.release();
    this.context = null;
  }
}

export const whisperService = new WhisperService();
