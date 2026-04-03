import { Platform } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { nanoid } from 'nanoid/non-secure';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { whisperService } from '../stt/WhisperService';
import { canaryService, CanaryService } from '../stt/CanaryService';
import { nativeTTSService } from '../tts/NativeTTSService';
import { UtteranceQueue } from './UtteranceQueue';
import type { ITranslationService } from '../translation/TranslationService';
import type { Utterance, PersonId, PipelineStage, Message, VoiceId } from '../../app/types';

// Cache after first load — dynamic imports are fast but not zero-cost on the hot path
let _translationService: ITranslationService | null = null;
let _translationServicePromise: Promise<ITranslationService> | null = null;

async function getTranslationService(): Promise<ITranslationService> {
  if (_translationService) return _translationService;
  if (!_translationServicePromise) {
    _translationServicePromise = (async () => {
      if (Platform.OS === 'ios') {
        _translationService = (await import('../translation/TranslationService.ios')).default;
      } else {
        _translationService = (await import('../translation/TranslationService.android')).default;
      }
      return _translationService;
    })();
  }
  return _translationServicePromise;
}

/**
 * Pre-loads the translation service and triggers model downloads for the active
 * language pair so the first real translation call returns instantly.
 * Call this after Whisper is ready (non-blocking — errors are swallowed).
 */
export async function warmupTranslation(): Promise<void> {
  const svc = await getTranslationService();
  const { personA, personB } = useSettingsStore.getState();
  await Promise.all([
    svc.downloadLanguagePair(personA.language, personB.language).catch(() => {}),
    svc.downloadLanguagePair(personB.language, personA.language).catch(() => {}),
  ]);
}


class PipelineOrchestrator {
  private readonly queue = new UtteranceQueue();

  constructor() {
    this.queue.setHandler(u => this.processUtterance(u));
  }

  submit(speakerId: PersonId, audioPath: string): void {
    const settings = useSettingsStore.getState();
    const personConfig =
      speakerId === 'person_a' ? settings.personA : settings.personB;
    const otherConfig =
      speakerId === 'person_a' ? settings.personB : settings.personA;

    const utterance: Utterance = {
      id: nanoid(),
      speakerId,
      audioPath,
      sourceLang: personConfig.language,
      targetLang: otherConfig.language,
    };

    this.queue.enqueue(utterance);
  }

  /** VAD mode — speaker will be auto-detected from Whisper language output. */
  submitAuto(audioPath: string): void {
    const utterance: Utterance = {
      id: nanoid(),
      speakerId: 'person_a', // placeholder — resolved after transcription
      audioPath,
      sourceLang: 'auto',    // signals auto-detection mode
      targetLang: '',        // resolved after language detection
    };
    this.queue.enqueue(utterance);
  }

  get isProcessing(): boolean {
    return this.queue.isProcessing;
  }

  clearQueue(): void {
    this.queue.clear();
  }

  private async processUtterance(utterance: Utterance): Promise<void> {
    const { addMessage, updateMessage, setPipelineStage } =
      useConversationStore.getState();
    const settings = useSettingsStore.getState();
    const { autoPlay } = settings;
    const messageId = utterance.id;

    const isAutoMode = utterance.sourceLang === 'auto';
    let speakerId = utterance.speakerId;
    let sourceLang = utterance.sourceLang;
    let targetLang = utterance.targetLang;
    let preTranscribedText: string | null = null;

    try {
      // ── Auto-detect speaker via translation direction ───────────────────
      if (isAutoMode) {
        setPipelineStage('transcribing');
        const resolved = await detectSpeakerViaTranslation(
          utterance.audioPath,
          settings.personA.language,
          settings.personB.language,
        );
        if (!resolved) {
          setPipelineStage('idle');
          return;
        }

        speakerId = resolved.speakerId;
        preTranscribedText = resolved.originalText;
        sourceLang = resolved.sourceLang;
        targetLang = resolved.targetLang;
      }

      // Surface language detection to the UI (first-utterance toast)
      if (isAutoMode) {
        const { setDetectedLang, detectedLangs } = useConversationStore.getState();
        const prev = detectedLangs[speakerId];
        if (!prev || prev.lang !== sourceLang) {
          setDetectedLang(speakerId, sourceLang);
        }
      }

      const listenerConfig =
        speakerId === 'person_a' ? settings.personB : settings.personA;

      addMessage({
        id: messageId,
        speakerId,
        originalText: preTranscribedText ?? '',
        translatedText: null,
        stage: preTranscribedText ? 'translating' : 'transcribing',
        timestamp: Date.now(),
      });

      // Stage 1: STT (skip if already transcribed during auto-detect)
      setPipelineStage('transcribing');
      const transcribedText = await this.runSTT(
        utterance, messageId, sourceLang, preTranscribedText, updateMessage, setPipelineStage,
      );
      if (!transcribedText) return;

      // Stage 2: Translation — always done fresh to guarantee correct output
      setPipelineStage('translating');
      const translatedText = await this.runTranslation(
        messageId, transcribedText, sourceLang, targetLang, updateMessage,
      );

      // Stage 3: TTS
      if (!autoPlay) {
        setPipelineStage('idle');
        return;
      }

      console.warn(`[TTS-DEBUG] transcribed="${transcribedText}" translated="${translatedText}" target="${targetLang}"`);

      setPipelineStage('synthesizing');
      await this.runTTS(
        translatedText, targetLang,
        listenerConfig.voice, setPipelineStage,
      );

      setPipelineStage('idle');
    } catch (e) {
      console.error('[Pipeline] Utterance processing failed:', e);
      setPipelineStage('idle');
    } finally {
      // Cleanup VAD segment files after processing
      if (isAutoMode) {
        RNFS.unlink(utterance.audioPath).catch(() => {});
      }
    }
  }

  private async runSTT(
    utterance: Utterance,
    messageId: string,
    sourceLang: string,
    preTranscribedText: string | null,
    updateMessage: (id: string, patch: Partial<Message>) => void,
    setPipelineStage: (stage: PipelineStage) => void,
  ): Promise<string | null> {
    if (preTranscribedText) return preTranscribedText;

    try {
      const result = await whisperService.transcribe(utterance.audioPath, sourceLang);
      const cleaned = result.text.trim();
      if (!cleaned || /^\[.*\]$/.test(cleaned)) {
        useConversationStore.getState().removeMessage(messageId);
        setPipelineStage('idle');
        return null;
      }
      updateMessage(messageId, { originalText: cleaned, stage: 'translating' });
      return cleaned;
    } catch {
      updateMessage(messageId, { originalText: '[Transcription failed]', stage: 'error' });
      setPipelineStage('idle');
      return null;
    }
  }

  private async runTranslation(
    messageId: string,
    transcribedText: string,
    sourceLang: string,
    targetLang: string,
    updateMessage: (id: string, patch: Partial<Message>) => void,
  ): Promise<string> {
    try {
      const svc = await getTranslationService();
      const translation = await svc.translate(transcribedText, sourceLang, targetLang);
      updateMessage(messageId, { translatedText: translation.text, stage: 'done' });
      return translation.text;
    } catch {
      updateMessage(messageId, { stage: 'error' });
      return transcribedText;
    }
  }

  private async runTTS(
    translatedText: string,
    targetLang: string,
    voice: VoiceId,
    setPipelineStage: (stage: PipelineStage) => void,
  ): Promise<void> {
    // ZipVoice (voice-cloning TTS) can't reliably handle cross-lingual synthesis:
    // the Spanish reference audio biases the model to produce Spanish output even
    // when the target text is English.  Always use native OS TTS for translations.
    setPipelineStage('playing');
    await nativeTTSService.speak(translatedText, targetLang, voice);
  }
}

export const pipelineOrchestrator = new PipelineOrchestrator();

// ── React to language changes: pre-download new pair models ─────────────
let _prevLangA: string | null = null;
let _prevLangB: string | null = null;

useSettingsStore.subscribe(state => {
  const langA = state.personA.language;
  const langB = state.personB.language;

  if (_prevLangA === null) {
    // First run — just record, warmup already happened at startup
    _prevLangA = langA;
    _prevLangB = langB;
    return;
  }

  if (langA !== _prevLangA || langB !== _prevLangB) {
    _prevLangA = langA;
    _prevLangB = langB;

    // Pre-download models for the new pair so the next translation doesn't block
    warmupTranslation().catch(() => {});

    // Discard any queued utterances that were captured with the old language pair
    pipelineOrchestrator.clearQueue();
  }
});

/** Reset auto-speaker tracking (call when starting a new VAD session). */
export function resetAutoSpeaker(): void {
  // No-op — speaker state is now stateless (detected per-utterance)
}

// ── Speaker detection for VAD mode ───────────────────────────────────────────

interface AutoDetectResult {
  readonly speakerId: PersonId;
  readonly originalText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
}

/**
 * Determine who spoke using multi-signal language identification.
 *
 * When Canary supports the language pair (en/es/de/fr):
 *   Runs both Canary engines in parallel — no auto-translation possible.
 *   ML Kit picks the correct transcript from the two results.
 *
 * Otherwise (other language pairs):
 *   Falls back to Whisper + multi-signal detection (may have auto-translation issues).
 */
async function detectSpeakerViaTranslation(
  audioPath: string,
  langA: string,
  langB: string,
): Promise<AutoDetectResult | null> {
  const svc = await getTranslationService();

  // ── Canary path: zero auto-translation risk ───────────────────────────────
  if (CanaryService.supportsLanguagePair(langA, langB) && canaryService.isReady) {
    return detectSpeakerViaCanary(audioPath, langA, langB, svc);
  }

  // ── Whisper fallback ──────────────────────────────────────────────────────
  return detectSpeakerViaWhisper(audioPath, langA, langB, svc);
}

/**
 * Canary dual-engine speaker detection.
 *
 * Runs both engines simultaneously and uses ML Kit on the resulting texts
 * to pick the one that matches the actual spoken language.
 * Since each engine uses srcLang=tgtLang, neither can ever translate.
 */
async function detectSpeakerViaCanary(
  audioPath: string,
  langA: string,
  langB: string,
  svc: ITranslationService,
): Promise<AutoDetectResult | null> {
  const dual = await canaryService.transcribeBoth(audioPath);
  if (!dual) return null;

  const { textA, textB } = dual;

  // Discard if both engines produced empty / noise-only output
  if ((!textA || /^\[.*\]$/.test(textA)) && (!textB || /^\[.*\]$/.test(textB))) {
    return null;
  }

  const normA = langA.split('-')[0].split('_')[0].toLowerCase();
  const normB = langB.split('-')[0].split('_')[0].toLowerCase();

  // Prefer the transcript where ML Kit confidently identifies the language
  // as matching the engine's configured srcLang.
  const scoreA = await scoreTranscriptForLang(textA, normA, normB, svc);
  const scoreB = await scoreTranscriptForLang(textB, normB, normA, svc);

  let detectedLang: string;
  let originalText: string;

  if (scoreA >= scoreB && textA) {
    detectedLang = langA;
    originalText = textA;
    console.warn(`[Canary] picked engine_a lang=${langA} score=${scoreA.toFixed(2)} text="${textA.slice(0, 30)}"`);
  } else if (textB) {
    detectedLang = langB;
    originalText = textB;
    console.warn(`[Canary] picked engine_b lang=${langB} score=${scoreB.toFixed(2)} text="${textB.slice(0, 30)}"`);
  } else {
    return null;
  }

  // Phonetic garble check:
  // When Canary uses the wrong srcLang it sometimes force-maps audio phonetically
  // (e.g. Spanish "encantado" → garbled English "encantrated").
  // Condition: winner won confidently (≥0.9) but loser had low confidence (<0.8),
  // AND a long word in the winner shares ≥65% character overlap with a word in the loser.
  // This is narrower than a semantic check and avoids false positives when Canary
  // correctly translates (e.g. "Estoy muy bien" ↔ "I'm very well" — no shared chars).
  const winnerScore = detectedLang === langA ? scoreA : scoreB;
  const loserScore  = detectedLang === langA ? scoreB : scoreA;
  const loserText   = detectedLang === langA ? textB : textA;
  const loserLang   = detectedLang === langA ? langB : langA;

  if (
    loserText &&
    !/^\[.*\]$/.test(loserText) &&
    winnerScore >= 0.9 &&
    loserScore < 0.8 &&
    hasPhoneticGarbling(originalText, loserText)
  ) {
    detectedLang = loserLang;
    originalText = loserText;
    console.warn(`[Canary] garble-swap → lang=${detectedLang} text="${originalText.slice(0, 30)}"`);
  }

  const isLangA = detectedLang === langA;
  return {
    speakerId: isLangA ? 'person_a' : 'person_b',
    originalText,
    sourceLang: detectedLang,
    targetLang: isLangA ? langB : langA,
  };
}

/**
 * Returns true if any long word (≥5 chars) in `winner` shares ≥65% of its
 * characters (by LCS ratio) with any long word in `loser`.
 *
 * Catches phonetic transliterations like "encantrated" ↔ "encantado" (LCS=73%)
 * without triggering on genuine translations like "thanks" ↔ "gracias" (LCS=14%).
 */
function hasPhoneticGarbling(winner: string, loser: string): boolean {
  const LONG_WORD = /[a-záéíóúüñ]{5,}/gi;
  const winnerWords = winner.match(LONG_WORD) ?? [];
  const loserWords  = loser.match(LONG_WORD)  ?? [];

  for (const ww of winnerWords) {
    for (const lw of loserWords) {
      const ratio = lcsLength(ww.toLowerCase(), lw.toLowerCase()) /
                    Math.max(ww.length, lw.length);
      if (ratio >= 0.65) {
        console.warn(`[Canary] phonetic overlap ${ratio.toFixed(2)}: "${ww}" ↔ "${lw}"`);
        return true;
      }
    }
  }
  return false;
}

/** Longest common subsequence length (character-level). */
function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use two rolling rows to keep memory O(n)
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}

/**
 * Score how well a transcript matches a given language using ML Kit.
 * Returns 0–1 confidence. Falls back to 0.5 if ML Kit is inconclusive.
 */
async function scoreTranscriptForLang(
  text: string,
  targetLang: string,
  otherLang: string,
  svc: ITranslationService,
): Promise<number> {
  if (!text || /^\[.*\]$/.test(text)) return 0;

  try {
    const candidates = await svc.identifyLanguage(text);
    for (const c of candidates) {
      const norm = c.language.split('-')[0].split('_')[0].toLowerCase();
      if (norm === targetLang) return c.confidence;
    }
    // If the other language scores higher, this engine was wrong
    for (const c of candidates) {
      const norm = c.language.split('-')[0].split('_')[0].toLowerCase();
      if (norm === otherLang) return 1 - c.confidence; // penalise
    }
  } catch {
    // ML Kit unavailable — use heuristic
  }

  // Neutral fallback — tie-break by text length (longer = more confident transcription)
  return 0.5;
}

/**
 * Whisper-based speaker detection (fallback for non-Canary language pairs).
 * Subject to Whisper's auto-translation issue; uses multi-signal detection to mitigate.
 */
async function detectSpeakerViaWhisper(
  audioPath: string,
  langA: string,
  langB: string,
  svc: ITranslationService,
): Promise<AutoDetectResult | null> {
  // Step 1: Transcribe
  const result = await whisperService.transcribe(audioPath);
  const text = result.text.trim();
  if (!text || /^\[.*\]$/.test(text)) return null;

  // Step 2: Identify language — must be one of the two configured languages
  const detectedLang = await identifyLanguageMultiSignal(
    text, result.language, langA, langB, svc,
  );

  // If the language can't be confidently identified, discard this audio
  if (!detectedLang) return null;

  // Step 3: Map detected language → speaker
  const isLangA = detectedLang === langA;
  const audioLang = isLangA ? langA : langB;
  const targetLang = isLangA ? langB : langA;
  const speakerId: PersonId = isLangA ? 'person_a' : 'person_b';

  // Whisper sometimes auto-translates instead of transcribing (e.g. Spanish audio
  // → English text). Detect this by checking if the text language differs from the
  // audio language. When this happens, the text is already in the target language
  // and we should translate it BACK to get the original for display.
  const textLang = await detectTextLanguage(text, langA, langB, svc);
  const whisperAutoTranslated = textLang !== null && textLang !== audioLang;

  if (whisperAutoTranslated) {
    // Text is already in the target language — use it as-is for TTS,
    // and reverse-translate it back for the original display text.
    const originalText = await svc.translate(text, textLang, audioLang)
      .then(r => r.text)
      .catch(() => text);

    return {
      speakerId,
      originalText,
      sourceLang: audioLang,
      targetLang,
    };
  }

  return {
    speakerId,
    originalText: text,
    sourceLang: audioLang,
    targetLang,
  };
}

/**
 * Multi-signal language identification strictly constrained to two known languages.
 * Returns langA, langB, or null if the text cannot be confidently attributed to either.
 * When null is returned, the audio segment is discarded.
 */
async function identifyLanguageMultiSignal(
  text: string,
  whisperLang: string,
  langA: string,
  langB: string,
  svc: ITranslationService,
): Promise<string | null> {
  // Normalize language codes for comparison (strip region: "en-US" → "en")
  const normA = langA.split('-')[0].split('_')[0].toLowerCase();
  const normB = langB.split('-')[0].split('_')[0].toLowerCase();

  // Same language on both sides → auto-detect is meaningless
  if (normA === normB) return null;

  const normWhisper = whisperLang.split('-')[0].split('_')[0].toLowerCase();

  // Signal 1: Native language identification on text (ML Kit / NLLanguageRecognizer).
  // Most reliable for typical conversational text.
  const nativeLangResult = await tryNativeLangId(text, normA, normB, svc);
  if (nativeLangResult) {
    const nativeNorm = nativeLangResult.split('-')[0].split('_')[0].toLowerCase();

    // Cross-check for Whisper auto-translation: if ML Kit says the text is langB
    // but Whisper's audio lang says langA, Whisper silently translated the audio.
    // Trust the audio signal — the real speaker is langA.
    if (nativeNorm === normB && normWhisper === normA) {
      console.warn(`[LangDetect] auto-translate detected: whisper_audio=${normWhisper} ml_kit_text=${nativeNorm} → ${langA}`);
      return langA;
    }

    console.warn(`[LangDetect] signal=native text="${text.slice(0, 20)}" → ${nativeLangResult}`);
    return nativeLangResult;
  }

  // Signal 2: Whisper's audio-level language detection.
  // Unreliable for short clips (< 2s) but useful when ML Kit is inconclusive.
  if (normWhisper === normA) {
    console.warn(`[LangDetect] signal=whisper text="${text.slice(0, 20)}" → ${langA}`);
    return langA;
  }
  if (normWhisper === normB) {
    console.warn(`[LangDetect] signal=whisper text="${text.slice(0, 20)}" → ${langB}`);
    return langB;
  }

  // Signal 3: Translation heuristic (fallback)
  console.warn(`[LangDetect] signal=heuristic text="${text.slice(0, 20)}"`);
  return tryTranslationHeuristic(text, langA, langB, svc);
  // Returns null if inconclusive — audio will be discarded
}

/**
 * Use native language identification APIs to detect the language.
 * Returns langA, langB, or null if inconclusive.
 */
async function tryNativeLangId(
  text: string,
  normA: string,
  normB: string,
  svc: ITranslationService,
): Promise<string | null> {
  try {
    const candidates = await svc.identifyLanguage(text);
    if (candidates.length === 0) return null;

    // Find the best match among our two configured languages
    let scoreA = 0;
    let scoreB = 0;
    for (const c of candidates) {
      const normC = c.language.split('-')[0].split('_')[0].toLowerCase();
      if (normC === normA) scoreA = Math.max(scoreA, c.confidence);
      if (normC === normB) scoreB = Math.max(scoreB, c.confidence);
    }

    // Need at least 0.2 confidence and clear winner (1.5x margin)
    const minConfidence = 0.2;
    if (scoreA >= minConfidence && scoreA > scoreB * 1.5) return normA;
    if (scoreB >= minConfidence && scoreB > scoreA * 1.5) return normB;

    // If both have similar scores but one is significantly higher
    if (scoreA > 0 && scoreB > 0) {
      if (scoreA > scoreB * 1.2) return normA;
      if (scoreB > scoreA * 1.2) return normB;
    }

    // Single match with decent confidence
    if (scoreA >= 0.4 && scoreB === 0) return normA;
    if (scoreB >= 0.4 && scoreA === 0) return normB;
  } catch {
    // Native lang ID not available — continue to other signals
  }

  return null;
}

/**
 * Fallback: detect language by checking which translation direction changes the text.
 */
async function tryTranslationHeuristic(
  text: string,
  langA: string,
  langB: string,
  svc: ITranslationService,
): Promise<string | null> {
  const transAB = await svc.translate(text, langA, langB).catch(() => ({ text }));
  const transBA = await svc.translate(text, langB, langA).catch(() => ({ text }));

  const normalizedText = text.toLowerCase().trim();
  const changedAB = transAB.text.toLowerCase().trim() !== normalizedText;
  const changedBA = transBA.text.toLowerCase().trim() !== normalizedText;

  if (changedAB && !changedBA) return langA;
  if (changedBA && !changedAB) return langB;

  if (changedAB && changedBA) {
    // Both changed — compare normalized edit distance
    const diffAB = normalizedDifference(normalizedText, transAB.text.toLowerCase().trim());
    const diffBA = normalizedDifference(normalizedText, transBA.text.toLowerCase().trim());
    if (Math.abs(diffAB - diffBA) > 0.1) {
      return diffAB > diffBA ? langA : langB;
    }
  }

  return null;
}

/**
 * Normalized text difference using word-level comparison.
 * More robust than character-level for natural language.
 */
function normalizedDifference(a: string, b: string): number {
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  const maxLen = Math.max(wordsA.length, wordsB.length);
  if (maxLen === 0) return 0;

  let matching = 0;
  const remaining = new Set(wordsB);
  for (const word of wordsA) {
    if (remaining.has(word)) {
      matching++;
      remaining.delete(word);
    }
  }
  return 1 - matching / maxLen;
}

/**
 * Quick text language detection using native APIs.
 * Returns langA, langB, or null if unclear.
 */
async function detectTextLanguage(
  text: string,
  langA: string,
  langB: string,
  svc: ITranslationService,
): Promise<string | null> {
  const normA = langA.split('-')[0].split('_')[0].toLowerCase();
  const normB = langB.split('-')[0].split('_')[0].toLowerCase();
  return tryNativeLangId(text, normA, normB, svc);
}

