import { Platform } from 'react-native';
import { nanoid } from 'nanoid/non-secure';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useModelStore } from '../../store/modelStore';
import { whisperService } from '../stt/WhisperService';
import { zipvoiceService } from '../tts/ZipVoiceService';
import { nativeTTSService } from '../tts/NativeTTSService';
import { audioPlayerService } from '../tts/AudioPlayerService';
import { UtteranceQueue } from './UtteranceQueue';
import { readWavAsVoiceRef } from '../../utils/audioUtils';
import type { ITranslationService } from '../translation/TranslationService';
import type { Utterance, PersonId } from '../../app/types';

// Cache after first load — dynamic imports are fast but not zero-cost on the hot path
let _translationService: ITranslationService | null = null;

async function getTranslationService(): Promise<ITranslationService> {
  if (_translationService) return _translationService;
  if (Platform.OS === 'ios') {
    _translationService = (await import('../translation/TranslationService.ios')).default;
  } else {
    _translationService = (await import('../translation/TranslationService.android')).default;
  }
  return _translationService;
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

// Track last auto-detected speaker for turn-alternation fallback
let lastAutoSpeaker: PersonId | null = null;

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

  /** VAD mode — speaker will be auto-detected from translation direction. */
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

  private async processUtterance(utterance: Utterance): Promise<void> {
    const { addMessage, updateMessage, setPipelineStage } =
      useConversationStore.getState();
    const settings = useSettingsStore.getState();
    const messageId = utterance.id;

    const isAutoMode = utterance.sourceLang === 'auto';
    let speakerId = utterance.speakerId;
    let sourceLang = utterance.sourceLang;
    let targetLang = utterance.targetLang;
    let preTranscribedText: string | null = null;
    let preTranslatedText: string | null = null;

    // ── Auto-detect speaker via translation direction ─────────────────────
    if (isAutoMode) {
      setPipelineStage('transcribing');
      try {
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
        preTranslatedText = resolved.translatedText;
        sourceLang = resolved.sourceLang;
        targetLang = resolved.targetLang;
        lastAutoSpeaker = speakerId;
        console.log('[Pipeline] Speaker resolved →', {
          speakerId, sourceLang, targetLang,
          confidence: resolved.confidence,
        });
      } catch (e) {
        console.error('[Pipeline] Auto-detect failed:', e);
        setPipelineStage('idle');
        return;
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
    let transcribedText: string;
    if (preTranscribedText) {
      transcribedText = preTranscribedText;
    } else {
      try {
        const result = await whisperService.transcribe(
          utterance.audioPath,
          sourceLang,
        );
        const cleaned = result.text.trim();
        if (!cleaned || isWhisperNoise(cleaned)) {
          useConversationStore.getState().removeMessage(messageId);
          setPipelineStage('idle');
          return;
        }
        transcribedText = cleaned;
        updateMessage(messageId, { originalText: transcribedText, stage: 'translating' });
      } catch (e) {
        updateMessage(messageId, { originalText: '[Transcription failed]', stage: 'error' });
        setPipelineStage('idle');
        return;
      }
    }

    // Stage 2: Translation (skip if auto-detect already provided it)
    setPipelineStage('translating');
    let translatedText: string;
    if (preTranslatedText && !isSimilar(preTranslatedText, transcribedText)) {
      translatedText = preTranslatedText;
      console.log('[Pipeline] Translation (from auto-detect) →', { translatedText });
      updateMessage(messageId, { translatedText, stage: 'done' });
    } else {
      try {
        const svc = await getTranslationService();
        const translation = await svc.translate(transcribedText, sourceLang, targetLang);
        translatedText = translation.text;
        console.log('[Pipeline] Translation OK →', { from: sourceLang, to: targetLang, input: transcribedText, output: translatedText });
        updateMessage(messageId, { translatedText, stage: 'done' });
      } catch (e) {
        console.error('[Pipeline] Translation FAILED →', { from: sourceLang, to: targetLang, input: transcribedText, error: e });
        updateMessage(messageId, {
          translatedText: transcribedText,
          stage: 'error',
        });
        translatedText = transcribedText;
      }
    }

    // Stage 3: TTS
    console.log('[Pipeline] TTS →', { translatedText, targetLang, voice: listenerConfig.voice });
    if (!useSettingsStore.getState().autoPlay) {
      setPipelineStage('idle');
      return;
    }

    setPipelineStage('synthesizing');
    const zipvoiceReady = useModelStore.getState().zipvoiceStatus === 'ready';

    if (zipvoiceReady && zipvoiceService.isReady) {
      try {
        const voiceRef = await readWavAsVoiceRef(utterance.audioPath);
        const audioBuffer = await zipvoiceService.synthesize(
          translatedText,
          voiceRef,
          transcribedText,
          useSettingsStore.getState().ttsNumSteps,
        );
        setPipelineStage('playing');
        await audioPlayerService.play(audioBuffer);
      } catch (e) {
        console.error('[Pipeline] ZipVoice TTS failed, falling back to OS TTS', e);
        await nativeTTSService.speak(translatedText, targetLang, listenerConfig.voice);
      }
    } else {
      await nativeTTSService.speak(translatedText, targetLang, listenerConfig.voice);
    }

    setPipelineStage('idle');
  }
}

export const pipelineOrchestrator = new PipelineOrchestrator();

// ── Text normalization & comparison ──────────────────────────────────────────

/** Normalize text for comparison: lowercase, strip punctuation/whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?¡¿'"«»""''…\-–—()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if Whisper output is noise/silence markers. */
function isWhisperNoise(text: string): boolean {
  const t = text.trim();
  // Brackets: [BLANK_AUDIO], [Music], [silence], etc.
  if (/^\[.*\]$/.test(t)) return true;
  // Parentheses: (music), (silence), etc.
  if (/^\(.*\)$/.test(t)) return true;
  // Common Whisper hallucinations on silence
  if (/^(\.+|,+|\s+)$/.test(t)) return true;
  // Repeated single characters (common hallucination)
  if (/^(.)\1{3,}$/.test(t.replace(/\s/g, ''))) return true;
  // Too short to be meaningful (single word < 3 chars)
  if (t.length < 3) return true;
  // Common Whisper noise strings
  const noisePatterns = [
    'thank you', 'thanks for watching', 'subscribe',
    'gracias por ver', 'suscríbete',
    'you', 'bye', 'uh', 'um', 'hmm',
  ];
  if (noisePatterns.includes(t.toLowerCase())) return true;
  return false;
}

/**
 * Check if two texts are essentially the same after normalization.
 * Uses character-level similarity — texts are "similar" if >80% of characters match.
 */
function isSimilar(a: string, b: string, threshold = 0.80): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;

  // Quick check: if one contains the other
  if (na.includes(nb) || nb.includes(na)) return true;

  // Character-level similarity (good enough, avoids expensive Levenshtein)
  const sim = charSimilarity(na, nb);
  return sim >= threshold;
}

/** Rough character-level similarity: ratio of matching chars in order. */
function charSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // LCS-like count of matching characters
  let matches = 0;
  let bIdx = 0;
  for (let i = 0; i < a.length && bIdx < b.length; i++) {
    if (a[i] === b[bIdx]) {
      matches++;
      bIdx++;
    }
  }
  return matches / maxLen;
}

// ── Speaker detection for VAD mode ───────────────────────────────────────────

interface AutoDetectResult {
  readonly speakerId: PersonId;
  readonly originalText: string;
  readonly translatedText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

/**
 * Determine who spoke using ML Kit/iOS Translation as a language detector.
 *
 * Strategy:
 *  1. Transcribe with Whisper auto → get raw text (ignore language tag).
 *  2. Translate in BOTH directions via native translation.
 *  3. Compare NORMALIZED texts using similarity metric (not exact match).
 *  4. The direction that produces a DIFFERENT text = correct translation direction.
 *  5. Return the translation too so processUtterance can skip Stage 2.
 *
 * Key improvement over v1: uses normalized similarity comparison instead of
 * exact string equality, which avoids false positives from capitalization,
 * punctuation, or minor formatting differences.
 */
async function detectSpeakerViaTranslation(
  audioPath: string,
  langA: string,
  langB: string,
): Promise<AutoDetectResult | null> {
  // Transcribe — ignore the language tag, just get the text
  const result = await whisperService.transcribe(audioPath);
  const text = result.text.trim();

  if (!text || isWhisperNoise(text)) return null;

  console.log('[Pipeline] Transcribed →', { text, whisperLang: result.language });

  // Translate in both directions
  const svc = await getTranslationService();

  const [transAB, transBA] = await Promise.all([
    svc.translate(text, langA, langB).catch(() => ({ text })),
    svc.translate(text, langB, langA).catch(() => ({ text })),
  ]);

  // Compare using normalized similarity (NOT exact match)
  const simAB = charSimilarity(normalize(text), normalize(transAB.text));
  const simBA = charSimilarity(normalize(text), normalize(transBA.text));

  // A translation that CHANGED the text has LOW similarity to the original
  // A translation that kept it the same has HIGH similarity
  const UNCHANGED_THRESHOLD = 0.75; // above this = text didn't really change

  const unchangedAB = simAB >= UNCHANGED_THRESHOLD;
  const unchangedBA = simBA >= UNCHANGED_THRESHOLD;

  console.log('[Pipeline] Direction test →', {
    [`${langA}→${langB}`]: { result: transAB.text, similarity: simAB.toFixed(2), unchanged: unchangedAB },
    [`${langB}→${langA}`]: { result: transBA.text, similarity: simBA.toFixed(2), unchanged: unchangedBA },
  });

  // Case 1: A→B changed, B→A didn't → text is in langA → person A spoke
  if (!unchangedAB && unchangedBA) {
    return {
      speakerId: 'person_a',
      originalText: text,
      translatedText: transAB.text,
      sourceLang: langA,
      targetLang: langB,
      confidence: 'high',
    };
  }

  // Case 2: B→A changed, A→B didn't → text is in langB → person B spoke
  if (!unchangedBA && unchangedAB) {
    return {
      speakerId: 'person_b',
      originalText: text,
      translatedText: transBA.text,
      sourceLang: langB,
      targetLang: langA,
      confidence: 'high',
    };
  }

  // Case 3: Both changed → pick the direction with MORE change (lower similarity)
  if (!unchangedAB && !unchangedBA) {
    const isA = simAB < simBA; // lower similarity = more change = correct direction
    console.log('[Pipeline] Both changed — picking', isA ? langA : langB, 'as source');
    return {
      speakerId: isA ? 'person_a' : 'person_b',
      originalText: text,
      translatedText: isA ? transAB.text : transBA.text,
      sourceLang: isA ? langA : langB,
      targetLang: isA ? langB : langA,
      confidence: 'medium',
    };
  }

  // Case 4: Neither changed — use Whisper's language hint + alternation fallback
  console.log('[Pipeline] Neither direction changed text — using fallback');

  // Try Whisper's detected language as a weak signal
  const whisperLang = result.language?.split('-')[0]?.toLowerCase();
  if (whisperLang === langA) {
    return {
      speakerId: 'person_a',
      originalText: text,
      translatedText: text, // no translation available
      sourceLang: langA,
      targetLang: langB,
      confidence: 'low',
    };
  }
  if (whisperLang === langB) {
    return {
      speakerId: 'person_b',
      originalText: text,
      translatedText: text,
      sourceLang: langB,
      targetLang: langA,
      confidence: 'low',
    };
  }

  // Last resort: alternate speakers
  const speaker: PersonId =
    lastAutoSpeaker === 'person_a' ? 'person_b' : 'person_a';
  return {
    speakerId: speaker,
    originalText: text,
    translatedText: text,
    sourceLang: speaker === 'person_a' ? langA : langB,
    targetLang: speaker === 'person_a' ? langB : langA,
    confidence: 'low',
  };
}
