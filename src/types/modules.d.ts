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

// react-native-sherpa-onnx ships its own TypeScript declarations.
// No additional shims needed — import directly from the package.
