// ZipVoice distill-int8 TTS via react-native-sherpa-onnx
//
// Voice cloning: each call receives the speaker's own PTT audio (resampled
// to 24kHz, max 5s) + the Whisper transcription as the cloning reference.
// No separate enrollment — every utterance clones the voice on the fly.

import { createTTS } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';

export class ZipVoiceService {
  private engine: TtsEngine | null = null;

  get isReady(): boolean {
    return this.engine !== null;
  }

  async load(modelDir: string): Promise<void> {
    this.engine = await createTTS({
      modelPath: { type: 'file', path: modelDir },
      modelType: 'zipvoice',
      numThreads: 2,
    });
  }

  /**
   * Synthesize text using zero-shot voice cloning.
   *
   * @param text          - Translated text to speak (target language)
   * @param referenceAudio - Speaker's PTT audio at 24kHz (max 5s)
   * @param referenceText  - Whisper transcription of referenceAudio
   * @returns               PCM Float32Array at 24kHz
   */
  async synthesize(
    text: string,
    referenceAudio: Float32Array,
    referenceText: string,
    numSteps = 5,
  ): Promise<Float32Array> {
    if (!this.engine) throw new Error('[ZipVoiceService] Not loaded');

    const result = await this.engine.generateSpeech(text, {
      referenceAudio: { samples: Array.from(referenceAudio), sampleRate: 24000 },
      referenceText,
      numSteps,
      speed: 1.0,
    });

    return new Float32Array(result.samples);
  }

  async release(): Promise<void> {
    await this.engine?.destroy();
    this.engine = null;
  }
}

export const zipvoiceService = new ZipVoiceService();
