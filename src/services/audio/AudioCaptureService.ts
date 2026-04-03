import { Platform, PermissionsAndroid } from 'react-native';
import RNFS from 'react-native-fs';

// react-native-audio-record: records raw PCM and saves to a WAV file
// Docs: https://github.com/goodatlas/react-native-audio-record
import AudioRecord from 'react-native-audio-record';

const SAMPLE_RATE = 16000; // Required by Whisper
const CHANNELS = 1;        // Mono
const BITS_PER_SAMPLE = 16;

// Android AudioSource constants:
//   1 = MIC (raw, no processing)
//   6 = VOICE_RECOGNITION (AGC on, noise suppression off — good for STT)
//   7 = VOICE_COMMUNICATION (AGC + AEC + NS — best for conversations)
//
// VOICE_COMMUNICATION (7) is better for Parly because:
//   - Automatic Gain Control normalizes volume for soft/far speakers
//   - Acoustic Echo Cancellation helps when TTS plays from speaker
//   - Noise suppression helps in noisy environments (restaurants, etc.)
//
// If audio quality is still too low on specific devices, try switching to 6.
const ANDROID_AUDIO_SOURCE = 7;

// react-native-audio-record prepends getFilesDir() to wavFile, so pass just the filename.
const RECORDING_FILENAME = 'parly_recording.wav';
export const RECORDING_PATH = `${RNFS.DocumentDirectoryPath}/${RECORDING_FILENAME}`;

export class AudioCaptureService {
  private recording = false;
  private initialized = false;
  private streaming = false;

  private init(): void {
    if (this.initialized) return;
    AudioRecord.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: Platform.OS === 'android' ? ANDROID_AUDIO_SOURCE : 0,
      wavFile: RECORDING_FILENAME,
    });
    this.initialized = true;
  }

  /** Force re-init on next start (useful if audioSource settings change). */
  reinit(): void {
    this.initialized = false;
  }

  async requestPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Permiso de micrófono',
          message: 'Parly necesita acceso al micrófono para transcribir la conversación.',
          buttonPositive: 'Permitir',
          buttonNegative: 'Cancelar',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }

    // iOS permission is requested automatically by AVAudioSession
    // when recording starts. Info.plist must have NSMicrophoneUsageDescription.
    return true;
  }

  // ── PTT mode ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.recording) return;
    this.init();
    this.recording = true;
    AudioRecord.start();
  }

  async stop(): Promise<string> {
    if (!this.recording) return RECORDING_PATH;
    this.recording = false;
    const filePath: string = await AudioRecord.stop();
    return filePath || RECORDING_PATH;
  }

  // ── VAD streaming mode ───────────────────────────────────────────────────

  /** Start continuous capture, forwarding base64 PCM chunks via callback. */
  startStreaming(onData: (base64Pcm: string) => void): void {
    if (this.recording || this.streaming) return;
    this.init();
    AudioRecord.on('data', onData);
    this.streaming = true;
    this.recording = true;
    AudioRecord.start();
  }

  /** Stop continuous capture. */
  async stopStreaming(): Promise<void> {
    if (!this.streaming) return;
    this.streaming = false;
    this.recording = false;
    await AudioRecord.stop();
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }
}

export const audioCaptureService = new AudioCaptureService();
