// StreamingPipeline — orchestrates streaming ASR → re-translation → TTS overlap.
//
// Used in ACTIVE phase when both languages are known and Kroko streaming
// models are loaded. Falls back to offline pipeline if streaming is unavailable.
//
// Data flow:
//   speech_start → create ASR stream → feed audio chunks →
//     on partial: re-translate → stable prefix → update UI →
//       if new clause: TTS on stable content
//   speech_end → finalize ASR → final translation → TTS remainder

import { nanoid } from 'nanoid/non-secure';
import type { SttStream } from 'react-native-sherpa-onnx/stt';
import { streamingSTTService } from '../stt/StreamingSTTService';
import { ReTranslator } from './ReTranslator';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useModelStore } from '../../store/modelStore';
import { nativeTTSService } from '../tts/NativeTTSService';
import { getTranslationService } from '../translation/TranslationServiceSingleton';
import type { PersonId } from '../../app/types';

// ── PCM decoding ──────────────────────────────────────────────────────────────

/** Decode base64 Int16 PCM to Float32 array in [-1, 1]. */
function decodeBase64PcmToFloat32(base64Pcm: string): Float32Array {
  const binary = atob(base64Pcm);
  const numSamples = Math.floor(binary.length / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let sample = lo | (hi << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    float32[i] = sample / 32768;
  }
  return float32;
}

// ── Noise filter (shared with PipelineOrchestrator) ──────────────────────────

function isNoise(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3) return true;
  if (/^\[.*\]$/.test(t)) return true;
  if (/^\(.*\)$/.test(t)) return true;
  if (/^(\.+|,+|\s+)$/.test(t)) return true;
  if (/^(.)\1{3,}$/.test(t.replace(/\s/g, ''))) return true;
  const noise = ['thank you', 'thanks for watching', 'subscribe',
    'gracias por ver', 'suscríbete', 'you', 'bye', 'uh', 'um', 'hmm'];
  return noise.includes(t.toLowerCase());
}

// ── Streaming Pipeline ──────────────────────────────────────────────────────

/**
 * States:
 *   idle      — no active utterance
 *   starting  — startUtterance awaiting stream creation (blocks feedAudioChunk/endUtterance)
 *   streaming — streams created, actively feeding audio
 *   finalizing — endUtterance in progress
 */
type StreamingState = 'idle' | 'starting' | 'streaming' | 'finalizing';

class StreamingPipeline {
  private state: StreamingState = 'idle';
  private langA = '';
  private langB = '';

  // Active utterance state
  private streamA: SttStream | null = null;
  private streamB: SttStream | null = null;
  private reTranslatorA = new ReTranslator();
  private reTranslatorB = new ReTranslator();
  private bestStream: SttStream | null = null;
  private bestSpeaker: PersonId | null = null;
  private bestTextSoFar = '';
  private lastPartialA = '';
  private lastPartialB = '';
  private generation = 0;

  /**
   * Serialization lock for start/end/cancel operations.
   * Prevents concurrent entry into state-mutating methods.
   */
  private opLock: Promise<void> = Promise.resolve();

  /** Check if streaming is available for the current language pair. */
  isAvailable(): boolean {
    const krokoStatus = useModelStore.getState().krokoStatus;
    const langALoaded = streamingSTTService.isLoaded(this.langA);
    const langBLoaded = streamingSTTService.isLoaded(this.langB);
    const available = krokoStatus === 'ready'
      && this.langA !== ''
      && this.langB !== ''
      && langALoaded
      && langBLoaded;
    if (!available) {
      console.log('[StreamingPipeline] isAvailable=false:', {
        krokoStatus, langA: this.langA, langB: this.langB, langALoaded, langBLoaded,
      });
    }
    return available;
  }

  /** Configure the active language pair (call on ACTIVE phase transition). */
  async configure(langA: string, langB: string): Promise<void> {
    this.langA = langA.split('-')[0].toLowerCase();
    this.langB = langB.split('-')[0].toLowerCase();

    // Load sequentially to reduce peak memory (each encoder is ~153MB)
    await streamingSTTService.loadEngine(this.langA);
    await streamingSTTService.loadEngine(this.langB);
    console.log('[StreamingPipeline] Configured for', this.langA, '↔', this.langB);
  }

  /** Called by VADController on speech_start. Creates dual streams. */
  async startUtterance(): Promise<void> {
    // Serialize with any in-flight end/cancel
    await this.serialize(async () => {
      if (this.state !== 'idle') {
        await this.cancelUtteranceUnsafe();
      }

      this.generation++;
      const gen = this.generation;
      this.state = 'starting'; // blocks feedAudioChunk and endUtterance
      this.bestStream = null;
      this.bestSpeaker = null;
      this.bestTextSoFar = '';
      this.lastPartialA = '';
      this.lastPartialB = '';

      // Await stream creation — 'starting' state prevents concurrent access
      const [sA, sB] = await Promise.all([
        streamingSTTService.createStream(this.langA),
        streamingSTTService.createStream(this.langB),
      ]);

      // Check for cancellation during await
      if (gen !== this.generation) {
        await sA.release().catch(() => {});
        await sB.release().catch(() => {});
        this.state = 'idle';
        return;
      }

      this.streamA = sA;
      this.streamB = sB;
      this.reTranslatorA.start(this.langA, this.langB);
      this.reTranslatorB.start(this.langB, this.langA);

      this.state = 'streaming';
      useConversationStore.getState().setPipelineStage('streaming');
      console.log('[StreamingPipeline] Utterance started (gen:', gen, ')');
    });
  }

  /**
   * Feed a base64-encoded PCM chunk to both streams.
   * Called by VADController on each audio chunk during speech.
   * NOT serialized — runs concurrently but guards on state.
   */
  async feedAudioChunk(base64Pcm: string): Promise<void> {
    if (this.state !== 'streaming') return;
    const gen = this.generation;

    const samples = decodeBase64PcmToFloat32(base64Pcm);
    const sampleRate = 16000;

    const [resultA, resultB] = await Promise.all([
      this.streamA
        ? streamingSTTService.feedAudio(this.streamA, samples, sampleRate).catch(() => null)
        : Promise.resolve(null),
      this.streamB
        ? streamingSTTService.feedAudio(this.streamB, samples, sampleRate).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (gen !== this.generation || this.state !== 'streaming') return;

    const textA = resultA?.text?.trim() ?? '';
    const textB = resultB?.text?.trim() ?? '';

    if (textA) this.lastPartialA = textA;
    if (textB) this.lastPartialB = textB;

    // Pick the best stream: the one producing the most text
    const prevBestLen = this.bestTextSoFar.length;
    if (textA.length > textB.length && textA.length > prevBestLen) {
      this.bestStream = this.streamA;
      this.bestSpeaker = 'person_a';
      this.bestTextSoFar = textA;
    } else if (textB.length > textA.length && textB.length > prevBestLen) {
      this.bestStream = this.streamB;
      this.bestSpeaker = 'person_b';
      this.bestTextSoFar = textB;
    } else if (textA.length > prevBestLen && !this.bestStream) {
      this.bestStream = this.streamA;
      this.bestSpeaker = 'person_a';
      this.bestTextSoFar = textA;
    }

    // Re-translate the best partial
    const currentText = this.bestStream === this.streamA ? textA : textB;
    if (currentText && this.bestSpeaker && !isNoise(currentText)) {
      const reTranslator = this.bestSpeaker === 'person_a'
        ? this.reTranslatorA : this.reTranslatorB;
      const update = await reTranslator.onPartial(currentText);
      if (gen !== this.generation) return;

      if (update) {
        useConversationStore.getState().setStreamingPartial({
          speakerId: this.bestSpeaker,
          transcript: update.transcript,
          translation: update.fullTranslation,
          stableTranslation: update.stablePrefix,
        });
      } else {
        useConversationStore.getState().setStreamingPartial({
          speakerId: this.bestSpeaker,
          transcript: currentText,
          translation: '',
          stableTranslation: '',
        });
      }
    }
  }

  /**
   * Called by VADController on speech_end.
   * Finalizes ASR, does final translation, runs TTS.
   */
  async endUtterance(): Promise<void> {
    await this.serialize(async () => {
      if (this.state !== 'streaming') return;
      this.state = 'finalizing';
      const gen = this.generation;

      const store = useConversationStore.getState();
      const settings = useSettingsStore.getState();

      // Finalize both streams
      const [finalA, finalB] = await Promise.all([
        this.streamA ? streamingSTTService.finalize(this.streamA).catch(() => null) : null,
        this.streamB ? streamingSTTService.finalize(this.streamB).catch(() => null) : null,
      ]);

      this.streamA = null;
      this.streamB = null;

      if (gen !== this.generation) {
        store.setStreamingPartial(null);
        this.state = 'idle';
        return;
      }

      const textA = finalA?.text?.trim() ?? this.lastPartialA;
      const textB = finalB?.text?.trim() ?? this.lastPartialB;

      // Resolve speaker from final texts
      let speakerId: PersonId;
      let sourceLang: string;
      let targetLang: string;
      let finalText: string;

      if (textA.length >= textB.length && textA.length > 0) {
        speakerId = 'person_a';
        sourceLang = this.langA;
        targetLang = this.langB;
        finalText = textA;
      } else if (textB.length > 0) {
        speakerId = 'person_b';
        sourceLang = this.langB;
        targetLang = this.langA;
        finalText = textB;
      } else {
        store.setStreamingPartial(null);
        store.setPipelineStage('idle');
        this.state = 'idle';
        return;
      }

      if (isNoise(finalText)) {
        store.setStreamingPartial(null);
        store.setPipelineStage('idle');
        this.state = 'idle';
        return;
      }

      console.log('[StreamingPipeline] Final →', { speakerId, sourceLang, targetLang, finalText });

      store.setStreamingPartial(null);

      const messageId = nanoid();
      store.addMessage({
        id: messageId,
        speakerId,
        originalText: finalText,
        translatedText: null,
        stage: 'translating',
        timestamp: Date.now(),
      });

      // Final translation
      store.setPipelineStage('translating');
      let translatedText: string;
      try {
        const svc = await getTranslationService();
        const result = await svc.translate(finalText, sourceLang, targetLang);
        translatedText = result.text;
        store.updateMessage(messageId, { translatedText, stage: 'done' });
      } catch (e) {
        console.error('[StreamingPipeline] Final translation failed:', e);
        translatedText = finalText;
        store.updateMessage(messageId, { translatedText: finalText, stage: 'error' });
      }

      if (gen !== this.generation) {
        store.setStreamingPartial(null);
        this.state = 'idle';
        return;
      }

      // TTS
      if (!settings.autoPlay) {
        store.setPipelineStage('idle');
        this.state = 'idle';
        return;
      }

      store.setPipelineStage('synthesizing');
      const listenerConfig = speakerId === 'person_a' ? settings.personB : settings.personA;

      try {
        await nativeTTSService.speak(translatedText, targetLang, listenerConfig.voice);
      } catch (e) {
        console.error('[StreamingPipeline] TTS failed:', e);
      }

      if (gen !== this.generation) {
        this.state = 'idle';
        return;
      }

      store.setPipelineStage('idle');
      this.state = 'idle';
    });
  }

  /** Cancel the current streaming utterance. Thread-safe entry point. */
  async cancelUtterance(): Promise<void> {
    await this.serialize(() => this.cancelUtteranceUnsafe());
  }

  /** Release all resources. */
  async release(): Promise<void> {
    await this.cancelUtterance();
    await streamingSTTService.release();
    this.langA = '';
    this.langB = '';
  }

  get isStreaming(): boolean {
    return this.state === 'streaming';
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Cancel without acquiring the lock — caller must hold it. */
  private async cancelUtteranceUnsafe(): Promise<void> {
    this.generation++;
    if (this.streamA) {
      await streamingSTTService.releaseStream(this.streamA);
      this.streamA = null;
    }
    if (this.streamB) {
      await streamingSTTService.releaseStream(this.streamB);
      this.streamB = null;
    }
    this.state = 'idle';
    useConversationStore.getState().setStreamingPartial(null);
  }

  /** Serialize async operations to prevent concurrent state mutations. */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.opLock.then(fn, fn); // run even if previous op rejected
    this.opLock = next.catch(() => {});     // swallow to keep chain alive
    return next;
  }
}

export const streamingPipeline = new StreamingPipeline();
