// react-native-audio-record — PCM recording to WAV
declare module 'react-native-audio-record' {
  interface AudioRecordOptions {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource?: number;
    wavFile: string;
  }
  const AudioRecord: {
    init(options: AudioRecordOptions): void;
    start(): void;
    stop(): Promise<string>;
    on(event: 'data', callback: (data: string) => void): void;
  };
  export default AudioRecord;
}

// whisper.rn — re-export from package's typescript declarations
declare module 'whisper.rn' {
  export {
    WhisperContext,
    initWhisper,
    releaseAllWhisper,
  } from '../../../node_modules/whisper.rn/lib/typescript/index';
  export type {
    TranscribeOptions,
    TranscribeResult,
    ContextOptions,
    TranscribeFileOptions,
  } from '../../../node_modules/whisper.rn/lib/typescript/index';
}

// react-native-sherpa-onnx ships its own TypeScript declarations.
// No additional shims needed — import directly from the package.
