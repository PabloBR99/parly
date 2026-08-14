import { Platform, PermissionsAndroid } from 'react-native';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { log } from '../log/logStore';

// react-native-audio-record: records raw PCM and saves to a WAV file
// Docs: https://github.com/goodatlas/react-native-audio-record
import AudioRecord from 'react-native-audio-record';

const SAMPLE_RATE = 16000; // Required by Whisper
const CHANNELS = 1;        // Mono
const BITS_PER_SAMPLE = 16;

// Android AudioSource constants:
//   1 = MIC (raw, no processing)
//   6 = VOICE_RECOGNITION (minimal processing — the source tuned for STT)
//   7 = VOICE_COMMUNICATION (AGC + AEC + NS — the source tuned for telephony)
//
// Now 6, changed from 7 on device evidence rather than on the documentation
// alone. Three arguments, in the order they became convincing:
//
//   · AOSP's own guidance is that noise suppression should not be enabled for
//     recognition — it is tuned to make speech pleasant to a human ear over a
//     narrowband link, and an ASR is neither. That is what source 6 exists for.
//     https://source.android.com/docs/core/audio/implement-pre-processing
//
//   · The AGC on source 7 works directly against the noise floor tracking in
//     services/audio/noiseFloor.ts, which decides who is talking from how far
//     a frame sits above the room. AGC's whole job is to compress exactly that
//     distance: it lifts the room in the gaps. Relative gating survives it —
//     everything moves together — but with less headroom than it would have on
//     a source that leaves the levels alone.
//
//   · And the one that settled it. A capture session on device under source 7
//     logged `maxAmp=1.000` — full scale, clipping — with Silero returning
//     maxProb=0.023 on that same window, and a peak of 0.144 across an entire
//     conversation of ordinary speech. A VAD does not report 0.02 on speech
//     loud enough to clip unless something upstream has damaged the signal it
//     is being shown, and an AGC driving a near speaker into saturation is a
//     candidate with means and opportunity. The model being effectively mute
//     on this hardware has been treated as a property of the device since it
//     was first seen; it may turn out to be a property of the microphone
//     configuration instead, and that is worth an APK to find out.
//
// The counter-argument for 7 is its AEC, since TTS plays out of the same
// speaker the mic is listening to. Hands-free does not lean on it:
// ConversationOrchestrator gates the capture path by state and never feeds the
// transcriber while the phone is talking, precisely because the AEC here was
// always too device-dependent to trust. PTT never overlaps playback at all.
//
// What would send this back to 7: speech levels collapsing far enough that the
// gate's floor clamp (GATE_MIN_DBFS, -60 dBFS) starts rejecting real speech,
// or echo surviving the state gate during the 250 ms cooldown. Both are
// visible in the same [vad] log line this was decided from. It is a one-line
// revert.
const ANDROID_AUDIO_SOURCE = 6;

// react-native-audio-record prepends getFilesDir() to wavFile, so pass just the filename.
const RECORDING_FILENAME = 'parly_recording.wav';
export const RECORDING_PATH = `${DocumentDirectoryPath}/${RECORDING_FILENAME}`;

export class AudioCaptureService {
  private recording = false;
  private initialized = false;
  private streaming = false;
  private dataSubscription: { remove(): void } | null = null;

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
    this.dataSubscription = AudioRecord.on('data', onData) as unknown as { remove(): void };
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
