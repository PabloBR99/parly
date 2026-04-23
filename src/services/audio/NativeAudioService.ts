// NativeAudioService — TypeScript wrapper for the native audio capture + playback module.
//
// On Android: uses ParlyNativeAudio (Kotlin AudioRecord + AudioTrack) for capture
// and playback, with native Silero VAD integration. Audio data stays in native,
// only events and speech segments cross the RN bridge.
//
// On iOS: falls back to the existing JS-based AudioCaptureService.
//
// The interface is intentionally similar to AudioCaptureService so VADController
// can switch between them seamlessly.

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { ParlyNativeAudio } = NativeModules;

type AudioChunkCallback = (base64Pcm: string) => void;
type EventCallback = (event: 'speech_start' | 'speech_end') => void;
type AudioLevelCallback = (level: number) => void;

class NativeAudioService {
  private emitter: NativeEventEmitter | null = null;
  private subscriptions: Array<{ remove: () => void }> = [];
  private chunkCallbacks: AudioChunkCallback[] = [];
  private eventCallbacks: EventCallback[] = [];
  private levelCallbacks: AudioLevelCallback[] = [];
  private active = false;

  /** Whether the native module is available (Android only for now). */
  get isAvailable(): boolean {
    return Platform.OS === 'android' && ParlyNativeAudio != null;
  }

  /**
   * Start native audio capture with optional VAD.
   * @param emitChunks If true, base64 PCM chunks are sent to JS (for streaming ASR).
   */
  async startCapture(emitChunks = true): Promise<boolean> {
    if (!ParlyNativeAudio) return false;
    if (this.active) return true;

    this.setupEventListeners();
    const success: boolean = await ParlyNativeAudio.startCapture(emitChunks);
    this.active = success;
    return success;
  }

  async stopCapture(): Promise<void> {
    if (!ParlyNativeAudio || !this.active) return;
    this.active = false;
    await ParlyNativeAudio.stopCapture();
    this.removeEventListeners();
  }

  async pauseCapture(): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.pauseCapture();
  }

  async resumeCapture(): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.resumeCapture();
  }

  /**
   * Attach a Silero VAD to native capture for in-native speech detection.
   * Must be called after SileroVADService has loaded the model.
   */
  async attachVad(modelPath: string): Promise<boolean> {
    if (!ParlyNativeAudio) return false;
    try {
      await ParlyNativeAudio.attachVad(modelPath);
      return true;
    } catch (e) {
      console.error('[NativeAudioService] Failed to attach VAD:', e);
      return false;
    }
  }

  async detachVad(): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.detachVad();
  }

  /** Collect accumulated speech chunks from native VAD as base64 PCM. */
  async collectSpeechChunks(): Promise<string> {
    if (!ParlyNativeAudio) return '';
    return ParlyNativeAudio.collectSpeechChunks();
  }

  // ── Playback ──────────────────────────────────────────────────────────

  async playPCM(base64Data: string, sampleRate: number): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.playPCM(base64Data, sampleRate);
  }

  async startStreamPlayback(sampleRate = 24000): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.startStreamPlayback(sampleRate);
  }

  async feedStreamPCM(base64Data: string): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.feedStreamPCM(base64Data);
  }

  async finalizeStream(): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.finalizeStream();
  }

  async stopPlayback(): Promise<void> {
    if (!ParlyNativeAudio) return;
    await ParlyNativeAudio.stopPlayback();
  }

  // ── Event subscriptions ───────────────────────────────────────────────

  onAudioChunk(cb: AudioChunkCallback): () => void {
    this.chunkCallbacks.push(cb);
    return () => {
      this.chunkCallbacks = this.chunkCallbacks.filter(c => c !== cb);
    };
  }

  onVadEvent(cb: EventCallback): () => void {
    this.eventCallbacks.push(cb);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter(c => c !== cb);
    };
  }

  onAudioLevel(cb: AudioLevelCallback): () => void {
    this.levelCallbacks.push(cb);
    return () => {
      this.levelCallbacks = this.levelCallbacks.filter(c => c !== cb);
    };
  }

  get isActive(): boolean {
    return this.active;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private setupEventListeners(): void {
    if (!ParlyNativeAudio) return;

    this.emitter = new NativeEventEmitter(ParlyNativeAudio);

    this.subscriptions.push(
      this.emitter.addListener('onNativeSpeechStart', () => {
        for (const cb of this.eventCallbacks) cb('speech_start');
      }),
      this.emitter.addListener('onNativeSpeechEnd', () => {
        for (const cb of this.eventCallbacks) cb('speech_end');
      }),
      this.emitter.addListener('onNativeAudioChunk', (data: { data: string }) => {
        for (const cb of this.chunkCallbacks) cb(data.data);
      }),
      this.emitter.addListener('onNativeAudioLevel', (data: { level: number }) => {
        for (const cb of this.levelCallbacks) cb(data.level);
      }),
    );
  }

  private removeEventListeners(): void {
    for (const sub of this.subscriptions) {
      sub.remove();
    }
    this.subscriptions = [];
    this.emitter = null;
  }
}

export const nativeAudioService = new NativeAudioService();
