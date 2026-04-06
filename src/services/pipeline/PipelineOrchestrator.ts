import { nanoid } from 'nanoid/non-secure';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useModelStore } from '../../store/modelStore';
import { whisperService } from '../stt/WhisperService';
import { CanaryService, canaryService } from '../stt/CanaryService';
import { isKrokoLanguage } from '../stt/StreamingSTTService';
import { streamingPipeline } from './StreamingPipeline';
import { zipvoiceService } from '../tts/ZipVoiceService';
import { nativeTTSService } from '../tts/NativeTTSService';
import { audioPlayerService } from '../tts/AudioPlayerService';
import { UtteranceQueue } from './UtteranceQueue';
import { readWavAsVoiceRef } from '../../utils/audioUtils';
import { getTranslationService } from '../translation/TranslationServiceSingleton';
import { downloadKrokoForLanguage } from '../models/ModelManager';
import type { Utterance, PersonId } from '../../app/types';

// ── Language discovery state machine ──────────────────────────────────────────

type DiscoveryPhase = 'discovering_a' | 'discovering_b' | 'active';

let discoveryPhase: DiscoveryPhase = 'discovering_a';
let detectedLangA = '';
let detectedLangB = '';
/**
 * Candidate languages — set on the FIRST plausible detection (conf ≥ 0.4, len ≥ 3)
 * even before the commit threshold is reached. Once set, ONLY the same language can
 * commit for that slot. This prevents a later high-confidence utterance in a different
 * language from stealing langA/langB (e.g. "What's your name?" at conf=0.9999 can't
 * override a prior "Hola!" candidate even if "Hola!" didn't commit on its own).
 */
let langACandidate = '';
let langBCandidate = '';
/** Incremented on every resetDiscovery() so in-flight calls can detect stale sessions. */
let discoveryGeneration = 0;

/**
 * Minimum ML Kit confidence to commit langA/langB for long utterances (≥ 15 chars).
 */
const DISCOVERY_CONFIDENCE = 0.85;

/**
 * Minimum ML Kit confidence to commit for short utterances (≥ 4 chars).
 * Kept lower because ML Kit inherently gives less confidence to short words —
 * "Hola!" scores ~0.72 despite being unambiguously Spanish.
 */
const DISCOVERY_CONFIDENCE_SHORT = 0.50;

/**
 * Minimum ML Kit confidence for per-utterance routing in ACTIVE phase.
 */
const ACTIVE_CONFIDENCE = 0.5;

/**
 * Minimum confidence to tentatively lock a language candidate.
 * Low bar — the candidate only gates which language may later commit.
 */
const CANDIDATE_CONFIDENCE = 0.4;

/**
 * Minimum transcript length to set a language candidate or attempt a commit.
 * Filters out single characters and noise ("ok" = 2, "sí" = 2).
 */
const MIN_CANDIDATE_CHARS = 3;

/**
 * Default output language while langB is still unknown.
 * Person A's utterances will be translated into this language in DISCOVERING_B.
 */
const DEFAULT_LANG_B = 'en';

/** Reset discovery — call when starting a new conversation session. */
export function resetDiscovery(): void {
  discoveryGeneration++;
  discoveryPhase = 'discovering_a';
  detectedLangA = '';
  detectedLangB = '';
  langACandidate = '';
  langBCandidate = '';
  canaryService.release().catch(() => {}); // free ~414 MB; back to Whisper-only
  streamingPipeline.release().catch(() => {}); // release streaming engines
  console.log('[Pipeline] Discovery state reset');
}

/**
 * Returns true if lang/conf/len meet the bar to commit as langA or langB.
 * Two tiers: short words need ≥ 0.50, long utterances need ≥ 0.85.
 */
function canCommitDiscovery(lang: string, conf: number, len: number): boolean {
  if (!lang || len < MIN_CANDIDATE_CHARS) return false;
  return (conf >= DISCOVERY_CONFIDENCE_SHORT && len >= 4) ||
         (conf >= DISCOVERY_CONFIDENCE && len >= 15);
}

// ── Translation warmup ────────────────────────────────────────────────────────

/**
 * Pre-downloads ML Kit translation models for the active language pair.
 *
 * In VAD mode: no-op until both languages are discovered (ACTIVE phase).
 * In PTT mode: warms up the user-configured language pair immediately.
 * Called automatically on ACTIVE transition, and can be called from App.tsx after init.
 */
export async function warmupTranslation(): Promise<void> {
  const svc = await getTranslationService();

  if (discoveryPhase !== 'active') {
    // VAD mode has not yet discovered both languages — nothing to warm up.
    // PTT mode: the user pre-configured their language pair, warm that up.
    const { personA, personB, inputMode } = useSettingsStore.getState();
    if (inputMode !== 'ptt') return;
    await Promise.all([
      svc.downloadLanguagePair(personA.language, personB.language).catch(() => {}),
      svc.downloadLanguagePair(personB.language, personA.language).catch(() => {}),
    ]);
    return;
  }

  await Promise.all([
    svc.downloadLanguagePair(detectedLangA, detectedLangB).catch(() => {}),
    svc.downloadLanguagePair(detectedLangB, detectedLangA).catch(() => {}),
  ]);
}

// ── Streaming pipeline setup ──────────────────────────────────────────────────

/**
 * Download any missing Kroko models and configure the streaming pipeline.
 * Called on ACTIVE transition — runs in background, non-blocking.
 */
async function configureStreamingPipeline(langA: string, langB: string): Promise<void> {
  console.log('[Pipeline] configureStreamingPipeline starting for', langA, '↔', langB);
  try {
    // Ensure models are downloaded for both languages
    const downloads: Promise<void>[] = [];
    if (isKrokoLanguage(langA)) downloads.push(downloadKrokoForLanguage(langA));
    if (isKrokoLanguage(langB)) downloads.push(downloadKrokoForLanguage(langB));
    await Promise.all(downloads);

    // Both languages must be Kroko-supported for streaming
    if (!isKrokoLanguage(langA) || !isKrokoLanguage(langB)) {
      console.log('[Pipeline] Streaming not available: unsupported language pair', langA, langB);
      return;
    }

    await streamingPipeline.configure(langA, langB);
    console.log('[Pipeline] Streaming pipeline ready for', langA, '↔', langB);

    // Free Whisper (~244MB) — no longer needed in ACTIVE phase since Kroko handles
    // streaming and Whisper was only used during DISCOVERY. If streaming fails
    // mid-utterance, the fallback will re-init Whisper on demand.
    whisperService.release().catch(() => {});
    console.log('[Pipeline] Whisper released to free memory for streaming');
  } catch (e) {
    console.error('[Pipeline] Streaming pipeline setup failed (falling back to offline):', e);
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

class PipelineOrchestrator {
  private readonly queue = new UtteranceQueue();

  constructor() {
    this.queue.setHandler(u => this.processUtterance(u));
  }

  /** Manual PTT mode — speaker and languages are known in advance. */
  submit(speakerId: PersonId, audioPath: string): void {
    const settings = useSettingsStore.getState();
    const personConfig = speakerId === 'person_a' ? settings.personA : settings.personB;
    const otherConfig  = speakerId === 'person_a' ? settings.personB : settings.personA;

    const utterance: Utterance = {
      id: nanoid(),
      speakerId,
      audioPath,
      sourceLang: personConfig.language,
      targetLang: otherConfig.language,
    };
    this.queue.enqueue(utterance);
  }

  /** VAD mode — speaker and languages are discovered from the audio itself. */
  submitAuto(audioPath: string): void {
    const utterance: Utterance = {
      id: nanoid(),
      speakerId: 'person_a', // placeholder — resolved after transcription
      audioPath,
      sourceLang: 'auto',   // signals auto-detection mode
      targetLang: '',       // resolved after language detection
    };
    this.queue.enqueue(utterance);
  }

  get isProcessing(): boolean {
    return this.queue.isProcessing;
  }

  private async processUtterance(utterance: Utterance): Promise<void> {
    const { addMessage, updateMessage, setPipelineStage } =
      useConversationStore.getState();
    const messageId = utterance.id;
    const isAutoMode = utterance.sourceLang === 'auto';

    let speakerId = utterance.speakerId;
    let sourceLang = utterance.sourceLang;
    let targetLang = utterance.targetLang;
    let preTranscribedText: string | null = null;

    // ── Auto-detect: resolve speaker and languages ────────────────────────────
    if (isAutoMode) {
      setPipelineStage('transcribing');
      try {
        const resolved = await resolveAutoUtterance(utterance.audioPath);
        if (!resolved) {
          setPipelineStage('idle');
          return;
        }
        speakerId        = resolved.speakerId;
        preTranscribedText = resolved.transcribedText;
        sourceLang       = resolved.sourceLang;
        targetLang       = resolved.targetLang;
        console.log('[Pipeline] Resolved →', { speakerId, sourceLang, targetLang, phase: discoveryPhase });
      } catch (e) {
        console.error('[Pipeline] Auto-detect failed:', e);
        setPipelineStage('idle');
        return;
      }
    }

    const listenerConfig =
      speakerId === 'person_a'
        ? useSettingsStore.getState().personB
        : useSettingsStore.getState().personA;

    addMessage({
      id: messageId,
      speakerId,
      originalText: preTranscribedText ?? '',
      translatedText: null,
      stage: preTranscribedText ? 'translating' : 'transcribing',
      timestamp: Date.now(),
    });

    // Stage 1: STT — skip if already transcribed during auto-detect
    setPipelineStage('transcribing');
    let transcribedText: string;
    if (preTranscribedText) {
      transcribedText = preTranscribedText;
    } else {
      try {
        const result = await whisperService.transcribe(utterance.audioPath, sourceLang);
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

    // Stage 2: Translation
    setPipelineStage('translating');
    let translatedText: string;
    try {
      const svc = await getTranslationService();
      const translation = await svc.translate(transcribedText, sourceLang, targetLang);
      translatedText = translation.text;
      console.log('[Pipeline] Translation OK →', {
        from: sourceLang, to: targetLang,
        input: transcribedText, output: translatedText,
      });
      updateMessage(messageId, { translatedText, stage: 'done' });
    } catch (e) {
      console.error('[Pipeline] Translation FAILED →', {
        from: sourceLang, to: targetLang, input: transcribedText, error: e,
      });
      updateMessage(messageId, { translatedText: transcribedText, stage: 'error' });
      translatedText = transcribedText;
    }

    // Stage 3: TTS
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

// ── Noise filter ──────────────────────────────────────────────────────────────

function isWhisperNoise(text: string): boolean {
  const t = text.trim();
  if (/^\[.*\]$/.test(t)) return true;
  if (/^\(.*\)$/.test(t)) return true;
  if (/^(\.+|,+|\s+)$/.test(t)) return true;
  if (/^(.)\1{3,}$/.test(t.replace(/\s/g, ''))) return true;
  if (t.length < 3) return true;
  const noisePatterns = [
    'thank you', 'thanks for watching', 'subscribe',
    'gracias por ver', 'suscríbete',
    'you', 'bye', 'uh', 'um', 'hmm',
  ];
  if (noisePatterns.includes(t.toLowerCase())) return true;
  return false;
}

// ── Language discovery ────────────────────────────────────────────────────────

export interface AutoResolveResult {
  readonly speakerId: PersonId;
  readonly transcribedText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
}

/**
 * Resolve who spoke and in what language using a 3-phase discovery state machine.
 *
 * DISCOVERING_A — no language known yet:
 *   Transcribe → identifyLanguage. If confidence ≥ 0.85 and text ≥ 15 chars:
 *   set langA, advance to DISCOVERING_B, route as person_a → translate to DEFAULT_LANG_B.
 *   Otherwise ignore (can't route without knowing langA).
 *
 * DISCOVERING_B — langA known, waiting for langB:
 *   If detected lang ≠ langA with confidence ≥ 0.85 and text ≥ 15 chars:
 *     set langB, advance to ACTIVE, route as person_b.
 *   If detected lang = langA with confidence ≥ 0.5:
 *     route as person_a → translate to DEFAULT_LANG_B (still unknown what lang person_b speaks).
 *   Otherwise ignore.
 *
 * ACTIVE — both languages known:
 *   Identify language → langA: person_a → translate to langB.
 *   Identify language → langB: person_b → translate to langA.
 *   Any other language or low confidence: ignore.
 */
export async function resolveAutoUtterance(audioPath: string): Promise<AutoResolveResult | null> {
  // Snapshot the generation counter before the first await.
  // resetDiscovery() increments it, so any reset that occurs while this function
  // is suspended will be detected even if the phase happens to be the same value.
  const genAtEntry = discoveryGeneration;

  // ── ACTIVE + Canary: dual language-hinted transcription ─────────────────────
  //
  // Whisper (auto-detect) can silently translate audio into the wrong language
  // (e.g. Spanish audio → English transcript), which then misroutes the utterance.
  // Canary solves this by running two engines in parallel — one per language —
  // where each engine can ONLY transcribe in its own language. ML Kit picks the
  // winning transcript based on confidence.
  //
  // In ACTIVE phase, use Canary dual-engine for offline transcription — UNLESS both
  // languages are Kroko-supported (streaming pipeline handles those; Whisper is the
  // offline fallback, saving ~180MB RAM by not loading Canary).
  const { personA: _pA, personB: _pB } = useSettingsStore.getState();
  const krokoHandlesPair = isKrokoLanguage(_pA.language) && isKrokoLanguage(_pB.language);
  if (discoveryPhase === 'active' && !krokoHandlesPair && CanaryService.supportsLanguagePair(_pA.language, _pB.language)) {
    // Wait for engines if they are still loading (loadForPair was fired at ACTIVE transition)
    if (!canaryService.isLoadedFor(_pA.language, _pB.language)) {
      console.log('[Pipeline] ACTIVE: Canary engines loading — waiting up to 10 s…');
      const ready = await canaryService.waitForLoad(10_000);
      if (discoveryGeneration !== genAtEntry) return null;
      if (!ready) {
        console.log('[Pipeline] ACTIVE: Canary not ready after 10 s — dropping utterance');
        return null;
      }
    }

    const dual = await canaryService.transcribeBoth(audioPath);
    if (discoveryGeneration !== genAtEntry) return null;

    if (!dual) return null; // engines released mid-call (session reset)

    const svc = await getTranslationService();
    const [candidatesA, candidatesB] = await Promise.all([
      dual.textA && !isWhisperNoise(dual.textA)
        ? svc.identifyLanguage(dual.textA).catch(() => [])
        : Promise.resolve([]),
      dual.textB && !isWhisperNoise(dual.textB)
        ? svc.identifyLanguage(dual.textB).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (discoveryGeneration !== genAtEntry) return null;

    // Match on exact code or BCP-47 subtag (e.g. 'es' matches 'es-419' but not 'esl')
    const matchLang = (tag: string, code: string) =>
      tag === code || tag.startsWith(code + '-');

    const confA = candidatesA.find(c => matchLang(c.language, dual.langA))?.confidence ?? 0;
    const confB = candidatesB.find(c => matchLang(c.language, dual.langB))?.confidence ?? 0;
    console.log('[Pipeline] ACTIVE Canary →', {
      textA: dual.textA, confA,
      textB: dual.textB, confB,
    });

    if (confA < ACTIVE_CONFIDENCE && confB < ACTIVE_CONFIDENCE) {
      console.log('[Pipeline] ACTIVE: Canary both below threshold, dropping');
      return null;
    }

    // Drop only when the result is genuinely ambiguous: small margin AND winner isn't confident.
    // A winner with ≥ 0.95 confidence is always trusted — both engines can score high
    // (e.g. confA=0.9999, confB=0.9989) when Spanish audio hits a well-trained model,
    // but the Spanish engine still wins clearly in absolute terms.
    const useA = confA > confB;
    const winnerConf = useA ? confA : confB;
    const CONF_MARGIN = 0.05;
    if (winnerConf < 0.95 && Math.abs(confA - confB) < CONF_MARGIN) {
      console.log('[Pipeline] ACTIVE: Canary tie (confA:', confA, 'confB:', confB, '), dropping');
      return null;
    }
    const text    = useA ? dual.textA : dual.textB;
    const topLang = useA ? dual.langA : dual.langB;

    if (!text || isWhisperNoise(text)) return null;

    const { personA, personB } = useSettingsStore.getState();
    if (topLang === personA.language) {
      return { speakerId: 'person_a', transcribedText: text, sourceLang: personA.language, targetLang: personB.language };
    }
    if (topLang === personB.language) {
      return { speakerId: 'person_b', transcribedText: text, sourceLang: personB.language, targetLang: personA.language };
    }
    console.log('[Pipeline] ACTIVE: Canary topLang', topLang, 'not in known pair, dropping');
    return null;
  }

  // ── Whisper: auto-detect (DISCOVERY + ACTIVE fallback) ───────────────────────
  const result = await whisperService.transcribe(audioPath);
  const text = result.text.trim();
  if (!text || isWhisperNoise(text)) return null;

  // Bail if the session was reset while we were transcribing
  if (discoveryGeneration !== genAtEntry) return null;

  console.log('[Pipeline] Transcribed →', { text, phase: discoveryPhase });

  // Identify language via ML Kit
  const svc = await getTranslationService();
  const candidates = await svc.identifyLanguage(text).catch(() => []);
  const topLang = (candidates[0]?.language ?? '').split('-')[0].toLowerCase();
  const topConf = candidates[0]?.confidence ?? 0;

  // Bail again if reset happened during identifyLanguage
  if (discoveryGeneration !== genAtEntry) return null;

  console.log('[Pipeline] identifyLanguage →', { topLang, topConf, phase: discoveryPhase });

  // Helper: safe interim target when langB is unknown.
  // Translates to DEFAULT_LANG_B (en) unless langA is already 'en', in which case
  // pick the first user-configured language that differs from langA.
  const interimTarget = (): string => {
    const la = detectedLangA || topLang;
    if (la !== DEFAULT_LANG_B) return DEFAULT_LANG_B;
    const { personA, personB } = useSettingsStore.getState();
    const fallback = [personB.language, personA.language].find(l => l !== la);
    return fallback ?? 'es';
  };

  // ── DISCOVERING_A ────────────────────────────────────────────────────────
  // Always route as person_a so the user sees feedback immediately.
  // Candidate lock: lock langACandidate on the first plausible detection so
  // a later high-confidence utterance in a different language cannot steal langA.
  if (discoveryPhase === 'discovering_a') {
    // Lock candidate on first plausible detection (low bar)
    if (!langACandidate && topLang && topConf >= CANDIDATE_CONFIDENCE && text.length >= MIN_CANDIDATE_CHARS) {
      langACandidate = topLang;
      console.log('[Pipeline] langA candidate locked →', langACandidate, '(conf:', topConf, ')');
    }

    // Only commit the candidate language — never a different language
    const effectiveLang = langACandidate || topLang;
    const canCommit = topLang === effectiveLang && canCommitDiscovery(topLang, topConf, text.length);

    if (canCommit) {
      detectedLangA = topLang;
      discoveryPhase = 'discovering_b';
      useSettingsStore.getState().setPersonLanguage('person_a', detectedLangA);
      console.log('[Pipeline] langA committed →', detectedLangA);
    } else {
      console.log('[Pipeline] DISCOVERING_A: routing without commit (conf:', topConf, 'len:', text.length, 'candidate:', langACandidate, ')');
    }
    // Always show as person_a — sourceLang is best guess
    const srcLang = detectedLangA || effectiveLang || 'auto';
    return {
      speakerId: 'person_a',
      transcribedText: text,
      sourceLang: srcLang,
      targetLang: interimTarget(),
    };
  }

  // ── DISCOVERING_B ────────────────────────────────────────────────────────
  // Always route — show person_b if different lang detected, person_a otherwise.
  // Same candidate-lock pattern as discovering_a: lock langBCandidate on first
  // detection of a language different from langA.
  if (discoveryPhase === 'discovering_b') {
    const isDifferentDetection = topLang && topLang !== detectedLangA;

    // Lock langB candidate on first plausible different-language detection
    if (!langBCandidate && isDifferentDetection && topConf >= CANDIDATE_CONFIDENCE && text.length >= MIN_CANDIDATE_CHARS) {
      langBCandidate = topLang;
      console.log('[Pipeline] langB candidate locked →', langBCandidate, '(conf:', topConf, ')');
    }

    const isDifferentLang = langBCandidate
      ? topLang === langBCandidate   // only the locked candidate qualifies as "different"
      : isDifferentDetection;
    const canCommit = isDifferentLang && canCommitDiscovery(topLang, topConf, text.length);

    if (canCommit) {
      detectedLangB = topLang;
      discoveryPhase = 'active';
      useSettingsStore.getState().setPersonLanguage('person_b', detectedLangB);
      console.log('[Pipeline] langB committed →', detectedLangB, '— entering ACTIVE');
      warmupTranslation().catch(() => {});
      // Use streaming (Kroko) when both languages are supported — skip Canary to save ~180MB RAM.
      // When Kroko is unavailable, fall back to Canary dual-engine for ACTIVE phase.
      if (isKrokoLanguage(detectedLangA) && isKrokoLanguage(detectedLangB)) {
        void configureStreamingPipeline(detectedLangA, detectedLangB);
      } else {
        canaryService.loadForPair(detectedLangA, detectedLangB).catch(() => {});
      }
      return {
        speakerId: 'person_b',
        transcribedText: text,
        sourceLang: detectedLangB,
        targetLang: detectedLangA,
      };
    }

    // Different language detected but not enough confidence to commit — tentative person_b
    if (isDifferentLang && topConf >= ACTIVE_CONFIDENCE) {
      console.log('[Pipeline] DISCOVERING_B: tentative person_b (lang:', topLang, 'conf:', topConf, ')');
      return {
        speakerId: 'person_b',
        transcribedText: text,
        sourceLang: topLang,
        targetLang: detectedLangA,
      };
    }

    // Same language as A, or too low confidence — route as person A
    console.log('[Pipeline] DISCOVERING_B: routing as person_a (lang:', topLang, 'conf:', topConf, ')');
    return {
      speakerId: 'person_a',
      transcribedText: text,
      sourceLang: detectedLangA,
      targetLang: interimTarget(),
    };
  }

  // ── ACTIVE ───────────────────────────────────────────────────────────────
  // Read from settingsStore so manual overrides in Settings take effect immediately.
  // During discovery, setPersonLanguage() keeps settingsStore in sync with module state.
  const { personA, personB } = useSettingsStore.getState();
  const activeLangA = personA.language;
  const activeLangB = personB.language;

  if (topConf < ACTIVE_CONFIDENCE) {
    console.log('[Pipeline] ACTIVE: ignoring low-confidence detection (conf:', topConf, ')');
    return null;
  }
  if (topLang === activeLangA) {
    return {
      speakerId: 'person_a',
      transcribedText: text,
      sourceLang: activeLangA,
      targetLang: activeLangB,
    };
  }
  if (topLang === activeLangB) {
    return {
      speakerId: 'person_b',
      transcribedText: text,
      sourceLang: activeLangB,
      targetLang: activeLangA,
    };
  }
  console.log('[Pipeline] ACTIVE: ignoring unknown language', topLang,
    '(known:', activeLangA, '/', activeLangB, ')');
  return null;
}
