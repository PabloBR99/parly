// WaitKTranslator — wait-k simultaneous translation for streaming TTS.
//
// Starts translating after k source tokens arrive, before the speaker finishes.
// Output is FORWARD-ONLY (monotonic): each translation must extend the previous,
// never revise. This is the key constraint that makes it safe for TTS — you can't
// unsay audio that's already been played.
//
// Two translation streams run in parallel:
//   - ReTranslator → UI (can revise, shows best-effort full translation)
//   - WaitKTranslator → StreamingTTSScheduler → TTS (forward-only, spoken aloud)
//
// The wait-k approach trades some translation quality for massive latency reduction:
// TTS starts 1-3 seconds earlier because it doesn't wait for the full utterance.

import { getTranslationService } from '../translation/TranslationServiceSingleton';
import { extractNewTokens } from './TokenExtractor';

export class WaitKTranslator {
  private sourceLang = '';
  private targetLang = '';
  private k = 5;

  /** All source tokens accumulated so far. */
  private sourceTokens: string[] = [];
  /** Previously seen partial transcript (for diffing). */
  private prevTranscript = '';
  /** Committed TTS output — monotonic, never shrinks. */
  private committedOutput = '';
  /** Number of source tokens that have been translated so far. */
  private translatedUpTo = 0;
  /** Guard against concurrent translations. */
  private translating = false;
  /** Queued source tokens to translate next. */
  private pendingTokens = false;

  /** Reset state for a new utterance. */
  start(sourceLang: string, targetLang: string, waitK: number): void {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.k = waitK;
    this.sourceTokens = [];
    this.prevTranscript = '';
    this.committedOutput = '';
    this.translatedUpTo = 0;
    this.translating = false;
    this.pendingTokens = false;
  }

  /**
   * Feed a new partial transcript from streaming ASR.
   * Returns new forward-only content to dispatch to TTS, or null if nothing new.
   */
  async onPartial(transcript: string): Promise<string | null> {
    const trimmed = transcript.trim();
    if (!trimmed) return null;

    // Extract new tokens
    const newTokens = extractNewTokens(this.prevTranscript, trimmed);
    this.prevTranscript = trimmed;

    if (newTokens.length === 0) return null;

    // Accumulate source tokens
    for (const token of newTokens) {
      this.sourceTokens.push(token);
    }

    // Wait until we have k tokens before first translation
    if (this.sourceTokens.length < this.k) return null;

    // Translate all accumulated tokens
    return this.translateAccumulated();
  }

  /**
   * Finalize: translate any remaining source tokens.
   * Called at speech_end to flush the pipeline.
   */
  async finalize(finalTranscript: string): Promise<string | null> {
    const trimmed = finalTranscript.trim();
    if (!trimmed) return null;

    // Use final transcript tokens
    const finalTokens = trimmed.split(/\s+/);
    this.sourceTokens = finalTokens;
    this.prevTranscript = trimmed;

    // Force translate everything remaining
    if (this.sourceTokens.length > this.translatedUpTo) {
      return this.translateAccumulated();
    }

    return null;
  }

  /** Get the total committed output so far. */
  getCommittedOutput(): string {
    return this.committedOutput;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async translateAccumulated(): Promise<string | null> {
    if (this.translating) {
      this.pendingTokens = true;
      return null;
    }

    this.translating = true;

    try {
      // Translate all source tokens accumulated so far
      const sourceText = this.sourceTokens.join(' ');
      const svc = await getTranslationService();
      const result = await svc.translate(sourceText, this.sourceLang, this.targetLang);
      const fullTranslation = result.text.trim();

      this.translatedUpTo = this.sourceTokens.length;

      // Enforce monotonicity: output must extend committedOutput
      const newContent = this.extractForwardContent(fullTranslation);

      if (newContent) {
        this.committedOutput = this.committedOutput
          ? `${this.committedOutput} ${newContent}`
          : newContent;
        return newContent;
      }

      return null;
    } catch (e) {
      console.error('[WaitKTranslator] Translation failed:', e);
      return null;
    } finally {
      this.translating = false;

      // Process any queued tokens
      if (this.pendingTokens) {
        this.pendingTokens = false;
        // Fire-and-forget — result handled by the StreamingPipeline's next feedAudioChunk
        void this.translateAccumulated();
      }
    }
  }

  /**
   * Extract new forward-only content from a full translation.
   *
   * The translation of the growing source must be monotonic: each output
   * must start with the previous committed output. If the translation
   * diverges (different wording), we take the portion after the last
   * matching word as new content.
   */
  private extractForwardContent(fullTranslation: string): string | null {
    if (!this.committedOutput) {
      // First translation — everything is new
      return fullTranslation || null;
    }

    // Best case: translation extends committed prefix
    if (fullTranslation.startsWith(this.committedOutput)) {
      const remainder = fullTranslation.slice(this.committedOutput.length).trim();
      return remainder || null;
    }

    // Translation diverged — find longest matching prefix at word level
    const committedWords = this.committedOutput.split(/\s+/);
    const fullWords = fullTranslation.split(/\s+/);

    let matchLen = 0;
    const maxCheck = Math.min(committedWords.length, fullWords.length);
    for (let i = 0; i < maxCheck; i++) {
      if (committedWords[i] === fullWords[i]) {
        matchLen = i + 1;
      } else {
        break;
      }
    }

    // If significant prefix matches, take new words after the match
    if (matchLen >= committedWords.length * 0.5 && fullWords.length > committedWords.length) {
      // There are new words beyond what we've committed
      const newWords = fullWords.slice(committedWords.length);
      if (newWords.length > 0) {
        return newWords.join(' ');
      }
    }

    // Divergence too large — skip this translation to preserve monotonicity.
    // This is the conservative approach: better to miss content than to
    // speak conflicting translations.
    return null;
  }
}
