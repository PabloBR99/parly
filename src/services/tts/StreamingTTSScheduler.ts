// StreamingTTSScheduler — queues text fragments for sequential TTS playback.
//
// During streaming ASR, the ReTranslator emits stable translated prefixes.
// This scheduler buffers those fragments until a sentence boundary or minimum
// length threshold is reached, then speaks them sequentially via NativeTTSService.
//
// Forward-only: once a fragment is spoken, it cannot be revised.

import { nativeTTSService } from './NativeTTSService';
import { useConversationStore } from '../../store/conversationStore';
import type { VoiceId } from '../../app/types';

/**
 * Minimum characters to accumulate before dispatching a TTS fragment.
 * Prevents choppy speech from very short stable prefixes.
 */
const MIN_FRAGMENT_CHARS = 12;

/** Punctuation that signals a natural break point for TTS dispatch. */
const SENTENCE_BREAK_RE = /[.!?,;:]\s*$/;

interface SchedulerConfig {
  readonly targetLang: string;
  readonly voice: VoiceId;
}

class StreamingTTSScheduler {
  private config: SchedulerConfig | null = null;
  private generation = 0;
  private buffer = '';
  private speakingPromise: Promise<void> = Promise.resolve();
  private spokenText = '';
  private active = false;

  /**
   * Begin a new streaming TTS session. Cancels any in-flight session.
   * Call this when a new utterance starts and autoPlay is enabled.
   */
  start(targetLang: string, voice: VoiceId): void {
    this.cancel();
    this.generation++;
    this.config = { targetLang, voice };
    this.buffer = '';
    this.spokenText = '';
    this.active = true;
  }

  /**
   * Feed new stable translated content from the ReTranslator.
   * Content is buffered until a dispatch threshold is met, then queued for TTS.
   */
  feedStableContent(newContent: string): void {
    if (!this.active || !this.config || !newContent) return;

    this.buffer += newContent;

    // Dispatch if buffer has enough content or ends at a sentence break
    if (this.buffer.length >= MIN_FRAGMENT_CHARS || SENTENCE_BREAK_RE.test(this.buffer)) {
      const fragment = this.buffer.trim();
      this.buffer = '';
      if (fragment) {
        this.enqueueFragment(fragment);
      }
    }
  }

  /**
   * Feed the final remainder after ASR finalization + final translation.
   * Flushes any buffered content, then speaks the remainder.
   * Returns a promise that resolves when all TTS is complete.
   */
  async feedFinalRemainder(remainder: string): Promise<void> {
    if (!this.active || !this.config) return;

    // Flush buffer + remainder as one final fragment
    const finalText = (this.buffer + ' ' + remainder).trim();
    this.buffer = '';

    if (finalText) {
      this.enqueueFragment(finalText);
    }

    // Wait for all queued fragments to finish speaking
    await this.waitForCompletion();
  }

  /** Wait for all queued TTS fragments to finish playing. */
  async waitForCompletion(): Promise<void> {
    await this.speakingPromise;
  }

  /** Cancel the current session. Stops any in-flight TTS. */
  cancel(): void {
    this.generation++;
    this.active = false;
    this.buffer = '';
    this.config = null;
    this.spokenText = '';
    this.speakingPromise = Promise.resolve(); // break chain to prevent memory leak
    nativeTTSService.stop();
  }

  /** Returns everything that has been spoken so far (for remainder calculation). */
  getSpokenText(): string {
    return this.spokenText;
  }

  /** Whether a streaming TTS session is currently active. */
  get isActive(): boolean {
    return this.active;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private enqueueFragment(text: string): void {
    const gen = this.generation;
    const config = this.config;
    if (!config) return;

    this.speakingPromise = this.speakingPromise.then(async () => {
      if (gen !== this.generation || !this.active) return;

      // Set pipeline stage when actual audio playback begins, not at scheduler start
      useConversationStore.getState().setPipelineStage('streaming_tts');

      try {
        await nativeTTSService.speak(text, config.targetLang, config.voice);
      } catch (e) {
        console.error('[StreamingTTSScheduler] Fragment TTS failed:', e);
      }

      if (gen === this.generation) {
        this.spokenText += (this.spokenText ? ' ' : '') + text;
      }
    });
  }
}

export const streamingTTSScheduler = new StreamingTTSScheduler();
