// ReTranslator — implements the re-translation pattern for streaming pipeline.
//
// As ASR emits progressively longer partial transcripts, we re-translate the
// growing text and track which translated tokens are "stable" (unchanged across
// consecutive translations). Only stable prefixes are committed for TTS.

import { getTranslationService } from '../translation/TranslationServiceSingleton';

export interface ReTranslationUpdate {
  /** Full partial transcript from streaming ASR. */
  readonly transcript: string;
  /** Full translation of the current partial. */
  readonly fullTranslation: string;
  /** Stable prefix — unchanged across last N re-translations. */
  readonly stablePrefix: string;
  /** New stable content since the last update (for incremental TTS). */
  readonly newStableContent: string;
}

/**
 * Number of consecutive identical translations required before a prefix
 * is considered "stable" and safe to commit to TTS.
 */
const STABILITY_COUNT = 2;

/**
 * Minimum character change in the transcript before re-translating.
 * Prevents redundant translation calls on tiny additions.
 */
const MIN_CHARS_DELTA = 3;

export class ReTranslator {
  private sourceLang = '';
  private targetLang = '';
  private prevTranscript = '';
  private translationHistory: string[] = [];
  private committedStablePrefix = '';
  private spokenUpTo = '';
  private translating = false;
  private pendingTranscript: string | null = null;
  private idleResolve: (() => void) | null = null;

  /** Reset state for a new utterance. */
  start(sourceLang: string, targetLang: string): void {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.prevTranscript = '';
    this.translationHistory = [];
    this.committedStablePrefix = '';
    this.spokenUpTo = '';
    this.translating = false;
    this.pendingTranscript = null;
    this.idleResolve = null;
  }

  /**
   * Feed a new partial transcript. Returns null if no translation was triggered
   * (e.g., delta too small or a translation is already in-flight).
   */
  async onPartial(transcript: string): Promise<ReTranslationUpdate | null> {
    const trimmed = transcript.trim();
    if (!trimmed) return null;

    // Skip if delta is too small
    if (trimmed.length - this.prevTranscript.length < MIN_CHARS_DELTA) {
      // But still queue it — if a translation finishes, we'll pick it up
      this.pendingTranscript = trimmed;
      return null;
    }

    return this.translate(trimmed);
  }

  /** Translate the final transcript — always runs, ignores delta threshold. */
  async onFinal(transcript: string): Promise<ReTranslationUpdate | null> {
    const trimmed = transcript.trim();
    if (!trimmed) return null;
    // Wait for any in-flight translation without busy-polling
    if (this.translating) {
      await new Promise<void>(resolve => { this.idleResolve = resolve; });
    }
    return this.translate(trimmed);
  }

  /** Get the current stable prefix without triggering a new translation. */
  getStablePrefix(): string {
    return this.committedStablePrefix;
  }

  /** Get the remaining untranslated text after the stable prefix. */
  getUnstableRemainder(fullTranslation: string): string {
    if (!this.committedStablePrefix) return fullTranslation;
    if (fullTranslation.startsWith(this.committedStablePrefix)) {
      return fullTranslation.slice(this.committedStablePrefix.length).trim();
    }
    return fullTranslation;
  }

  /**
   * Mark content as dispatched to the StreamingTTSScheduler.
   * Content is queued (not yet audibly played) — used to compute the final
   * remainder after ASR finalization so we don't double-dispatch.
   */
  markAsDispatched(prefix: string): void {
    if (prefix.length > this.spokenUpTo.length && prefix.startsWith(this.spokenUpTo)) {
      this.spokenUpTo = prefix;
    }
  }

  /**
   * Get the portion of a full translation not yet dispatched to TTS.
   * Used after final translation to determine what still needs speaking.
   *
   * NOTE: If the final translation diverges from the dispatched prefix
   * (re-translation chose different wording), the full translation is
   * returned. This may cause partial repetition — a known limitation
   * of the re-translation approach for TTS.
   */
  getUnspokenRemainder(fullTranslation: string): string {
    if (!this.spokenUpTo) return fullTranslation;
    if (fullTranslation.startsWith(this.spokenUpTo)) {
      return fullTranslation.slice(this.spokenUpTo.length).trim();
    }
    return fullTranslation;
  }

  private async translate(transcript: string): Promise<ReTranslationUpdate | null> {
    if (this.translating) {
      // Queue latest transcript for when current translation finishes
      this.pendingTranscript = transcript;
      return null;
    }

    this.translating = true;
    this.prevTranscript = transcript;

    try {
      const svc = await getTranslationService();
      const result = await svc.translate(transcript, this.sourceLang, this.targetLang);
      const fullTranslation = result.text;

      this.translationHistory.push(fullTranslation);
      // Cap history to avoid unbounded growth — only last STABILITY_COUNT entries are used
      if (this.translationHistory.length > STABILITY_COUNT) {
        this.translationHistory.shift();
      }

      // Compute stable prefix: longest common prefix across last STABILITY_COUNT translations
      const stablePrefix = this.computeStablePrefix();

      // Determine new stable content
      const newStableContent = stablePrefix.length > this.committedStablePrefix.length
        ? stablePrefix.slice(this.committedStablePrefix.length).trim()
        : '';

      if (stablePrefix.length > this.committedStablePrefix.length) {
        this.committedStablePrefix = stablePrefix;
      }

      const update: ReTranslationUpdate = {
        transcript,
        fullTranslation,
        stablePrefix: this.committedStablePrefix,
        newStableContent,
      };

      return update;
    } catch (e) {
      console.error('[ReTranslator] Translation failed:', e);
      return null;
    } finally {
      this.translating = false;

      // Wake any waiter (onFinal)
      if (this.idleResolve) {
        this.idleResolve();
        this.idleResolve = null;
      }

      // Process any queued transcript
      if (this.pendingTranscript) {
        const pending = this.pendingTranscript;
        this.pendingTranscript = null;
        void this.translate(pending);
      }
    }
  }

  /**
   * Compute the longest common prefix across the last STABILITY_COUNT translations.
   * Word-boundary aligned to avoid cutting mid-word.
   */
  private computeStablePrefix(): string {
    const history = this.translationHistory;
    if (history.length < STABILITY_COUNT) return this.committedStablePrefix;

    const recent = history.slice(-STABILITY_COUNT);
    let prefix = recent[0];

    for (let i = 1; i < recent.length; i++) {
      prefix = longestCommonPrefix(prefix, recent[i]);
    }

    // Align to word boundary — don't cut mid-word
    const lastSpace = prefix.lastIndexOf(' ');
    if (lastSpace > 0 && lastSpace < prefix.length - 1) {
      prefix = prefix.slice(0, lastSpace + 1);
    }

    // Never shrink below what we already committed
    if (prefix.length < this.committedStablePrefix.length) {
      return this.committedStablePrefix;
    }

    return prefix;
  }
}

/** Character-level longest common prefix of two strings. */
function longestCommonPrefix(a: string, b: string): string {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return a.slice(0, i);
}
