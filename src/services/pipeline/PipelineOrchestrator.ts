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
    let preTranslatedText: string | null = null; // auto-mode provides translation too

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
        });
      } catch {
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
        // Whisper returns special tokens for silence/blank audio — drop silently
        const cleaned = result.text.trim();
        if (!cleaned || /^\[.*\]$/.test(cleaned)) {
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
    if (preTranslatedText && preTranslatedText !== transcribedText) {
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
          translatedText: transcribedText, // show original as fallback
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
        // Read speaker's PTT/VAD audio → resample 16kHz→24kHz → trim 5s
        const voiceRef = await readWavAsVoiceRef(utterance.audioPath);
        const audioBuffer = await zipvoiceService.synthesize(
          translatedText,
          voiceRef,
          transcribedText,
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

// ── Speaker detection for VAD mode ───────────────────────────────────────────

interface AutoDetectResult {
  readonly speakerId: PersonId;
  readonly originalText: string;
  readonly translatedText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
}

/**
 * Determine who spoke using ML Kit translation as a language detector.
 *
 * Whisper base auto-detection is unreliable — it often returns the wrong
 * language code. Instead we:
 *  1. Transcribe with auto (we only need the TEXT, not the language tag).
 *  2. Translate in BOTH directions via ML Kit (instant, cached models).
 *  3. The direction that CHANGES the text is correct → identifies the speaker.
 *  4. Returns the translation too, so processUtterance can skip Stage 2.
 */
async function detectSpeakerViaTranslation(
  audioPath: string,
  langA: string,
  langB: string,
): Promise<AutoDetectResult | null> {
  // Transcribe — ignore the language tag, just get the text
  const result = await whisperService.transcribe(audioPath);
  const text = result.text.trim();

  if (!text || /^\[.*\]$/.test(text)) return null;

  console.log('[Pipeline] Transcribed →', { text });

  // Translate in both directions sequentially (native module not thread-safe)
  const svc = await getTranslationService();
  const transAB = await svc.translate(text, langA, langB).catch(() => ({ text }));
  const transBA = await svc.translate(text, langB, langA).catch(() => ({ text }));

  const changedAB = transAB.text.trim() !== text;
  const changedBA = transBA.text.trim() !== text;

  console.log('[Pipeline] Direction test →', {
    [`${langA}→${langB}`]: changedAB ? transAB.text : '(unchanged)',
    [`${langB}→${langA}`]: changedBA ? transBA.text : '(unchanged)',
  });

  if (changedAB && !changedBA) {
    // A→B changed the text → original is in langA → speaker is person A
    return {
      speakerId: 'person_a',
      originalText: text,
      translatedText: transAB.text,
      sourceLang: langA,
      targetLang: langB,
    };
  }

  if (changedBA && !changedAB) {
    // B→A changed the text → original is in langB → speaker is person B
    return {
      speakerId: 'person_b',
      originalText: text,
      translatedText: transBA.text,
      sourceLang: langB,
      targetLang: langA,
    };
  }

  if (changedAB && changedBA) {
    // Both changed — pick direction with bigger change (more different = correct)
    const diffAB = textDifference(text, transAB.text);
    const diffBA = textDifference(text, transBA.text);
    const isA = diffAB >= diffBA;
    return {
      speakerId: isA ? 'person_a' : 'person_b',
      originalText: text,
      translatedText: isA ? transAB.text : transBA.text,
      sourceLang: isA ? langA : langB,
      targetLang: isA ? langB : langA,
    };
  }

  // Neither changed — fall back to alternation
  const speaker: PersonId =
    lastAutoSpeaker === 'person_a' ? 'person_b' : 'person_a';
  return {
    speakerId: speaker,
    originalText: text,
    translatedText: text,
    sourceLang: speaker === 'person_a' ? langA : langB,
    targetLang: speaker === 'person_a' ? langB : langA,
  };
}

/** Rough text difference: ratio of characters that differ (0 = identical, 1 = totally different). */
function textDifference(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) same++;
  }
  return 1 - same / maxLen;
}

