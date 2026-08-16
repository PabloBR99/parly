import { Platform, PermissionsAndroid } from 'react-native';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { log } from '../log/logStore';

// react-native-audio-record: records raw PCM and saves to a WAV file
// Docs: https://github.com/goodatlas/react-native-audio-record
import AudioRecord from 'react-native-audio-record';

/** What `AudioRecord.on` hands back: the library returns the
 *  NativeEventEmitter subscription it created, which is the only way to detach
 *  the listener again. Its bundled types say `void`. */
interface AudioDataSubscription {
  remove(): void;
}

// SAFETY: react-native-audio-record's own declaration types `on` as returning
// void, while its implementation returns `EventEmitter.addListener(...)`. The
// declaration is what is wrong here, not the runtime.
const onAudioData = AudioRecord.on as (
  event: 'data',
  callback: (data: string) => void,
) => AudioDataSubscription;

const SAMPLE_RATE = 16000; // Required by Whisper
const CHANNELS = 1;        // Mono
const BITS_PER_SAMPLE = 16;

// Android AudioSource constants:
//   1 = MIC (raw, no processing)
//   6 = VOICE_RECOGNITION (the source tuned for speech recognition)
//   7 = VOICE_COMMUNICATION (AGC + AEC + NS — the source tuned for telephony)
//
// This was 7 for most of the app's life, chosen on the reasoning that more
// processing is more help: gain control for soft speakers, echo cancellation
// under TTS, noise suppression in restaurants. Two of those three turn out to
// be arguments against it.
//
// Noise suppression is the one that matters here. It is a spectral gate, and
// what a gate does for a living is delete low-level signal — which is what
// quiet speech IS. A speaker talking softly is exactly the input it was built
// to remove, and "soft speech gets lost" is the symptom that sent us looking.
// It is also tuned to make a voice pleasant to a human ear over a narrowband
// link, and an ASR is not a human ear. AOSP says so directly, and having a
// separate source for recognition is what it says it with:
//   https://source.android.com/docs/core/audio/implement-pre-processing
//
// The gain control is not free either. A capture session on device under 7
// logged maxAmp=1.000 — full scale, clipping — on ordinary conversational
// speech. An AGC driving a near speaker into saturation is doing damage, not
// help, and there is nothing downstream that can undo it.
//
// That leaves the echo canceller as the only real argument for 7, and neither
// mode leans on it. PTT never overlaps playback at all — the button is held or
// it is not. Hands-free gates the capture path by state in
// ConversationOrchestrator and never feeds the transcriber while the phone is
// talking, precisely because the AEC here was always too device-dependent to
// trust on its own.
//
// What would send this back to 7: echo surviving the state gate during the
// 250 ms cooldown — hands-free translating its own voice. It is a one-line
// revert, and it is the only thing to watch for.
const ANDROID_AUDIO_SOURCE = 6;

// react-native-audio-record prepends getFilesDir() to wavFile, so pass just the filename.
const RECORDING_FILENAME = 'parly_recording.wav';
export const RECORDING_PATH = `${DocumentDirectoryPath}/${RECORDING_FILENAME}`;

export class AudioCaptureService {
  private recording = false;
  private initialized = false;
  private streaming = false;
  private dataSubscription: AudioDataSubscription | null = null;

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

  /** Non-interactive check — never shows a dialog. */
  async hasPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      try {
        return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      } catch {
        return false;
      }
    }
    // iOS permission is requested automatically by AVAudioSession when
    // recording starts. Info.plist must have NSMicrophoneUsageDescription.
    return true;
  }

  async requestPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone permission',
          message: 'Parly needs microphone access to transcribe the conversation.',
          buttonPositive: 'Allow',
          buttonNegative: 'Cancel',
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
    if (this.recording || this.streaming) {
      log.warn(`[audio] startStreaming blocked — recording=${this.recording} streaming=${this.streaming}`);
      return;
    }
    this.init();
    this.dataSubscription = onAudioData('data', onData);
    this.streaming = true;
    this.recording = true;
    AudioRecord.start();
    log.info('[audio] startStreaming started');
  }

  /** Stop continuous capture. */
  async stopStreaming(): Promise<void> {
    if (!this.streaming) return;
    this.streaming = false;
    this.recording = false;
    // Capture + null the subscription BEFORE the await. If a new turn's
    // startStreaming lands while AudioRecord.stop() is in flight (the recovery
    // press right after an error), it must get a clean slot — otherwise this
    // continuation would remove the NEW turn's listener and the next turn
    // records into the void. Removing the captured sub only after the stop
    // preserves delivery of the trailing in-flight chunk on the normal
    // release path.
    const sub = this.dataSubscription;
    this.dataSubscription = null;
    await AudioRecord.stop();
    sub?.remove();
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }
}

export const audioCaptureService = new AudioCaptureService();
