import { NativeModules, Platform } from 'react-native';

const SAMPLE_RATE = 24000; // Voxtral outputs 24kHz

export class AudioPlayerService {
  private playing = false;

  async play(buffer: Float32Array): Promise<void> {
    if (this.playing) return;
    this.playing = true;

    try {
      await this.playPCM(buffer);
    } finally {
      this.playing = false;
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  stop(): void {
    this.playing = false;
    NativeModules.ParlyAudio?.stopPlayback?.();
  }

  private async playPCM(buffer: Float32Array): Promise<void> {
    // Convert Float32 [-1, 1] to Int16 PCM
    const int16 = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, buffer[i] * 32768));
    }

    // Platform-specific PCM playback via native module or Audio API
    if (NativeModules.ParlyAudio?.playPCM) {
      const uint8 = new Uint8Array(int16.buffer);
      const base64 = btoa(String.fromCharCode(...uint8));
      await NativeModules.ParlyAudio.playPCM(base64, SAMPLE_RATE);
    } else {
      // Dev fallback: estimate duration and wait
      const durationMs = (buffer.length / SAMPLE_RATE) * 1000;
      await new Promise<void>(resolve => setTimeout(resolve, durationMs));
    }
  }
}

export const audioPlayerService = new AudioPlayerService();
