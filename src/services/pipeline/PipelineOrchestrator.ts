import { nanoid } from 'nanoid/non-secure';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useModelStore } from '../../store/modelStore';
import { whisperService } from '../stt/WhisperService';
import { resolveSttAdapter } from '../stt/SttAdapterResolver';
import { offlineSttAdapter } from '../stt/OfflineSttAdapter';
import { probeNetworkNow } from '../network/monitor';
// Canary disabled in v3.0 — audio-first LID will replace dual-engine workaround
// import { CanaryService, canaryService } from '../stt/CanaryService';
import { isKrokoLanguage } from '../stt/StreamingSTTService';
import { streamingPipeline } from './StreamingPipeline';
import { zipvoiceService } from '../tts/ZipVoiceService';
import { nativeTTSService } from '../tts/NativeTTSService';
import { audioPlayerService } from '../tts/AudioPlayerService';
import { UtteranceQueue } from './UtteranceQueue';
import { readWavAsVoiceRef } from '../../utils/audioUtils';
import { getTranslationService } from '../translation/TranslationServiceSingleton';
import { audioLIDService } from '../lid/AudioLIDService';
import { downloadKrokoForLanguage } from '../models/ModelManager';
import { memoryMonitor } from '../memory/MemoryMonitor';
import type { Utterance, PersonId, TranscriptionResult } from '../../app/types';

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
  pendingStreamingConfig = null;
  // Canary disabled in v3.0 — no release() call needed (would reference undefined import)
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
 * Deferred streaming pipeline configuration.
 * Set during ACTIVE transition, consumed by processUtterance AFTER TTS finishes
 * to avoid OOM from concurrent Kroko engine load (~306MB) + TTS playback.
 */
let pendingStreamingConfig: { langA: string; langB: string } | null = null;

/** Consume and run any deferred streaming pipeline setup, unless discovery was reset. */
export async function flushPendingStreamingConfig(): Promise<void> {
  const pending = pendingStreamingConfig;
  if (!pending) return;
  pendingStreamingConfig = null;
  const gen = discoveryGeneration;
  await configureStreamingPipeline(pending.langA, pending.langB);
  if (discoveryGeneration !== gen) {
    console.log('[Pipeline] Discovery reset during streaming config — releasing');
    streamingPipeline.release().catch(() => {});
  }
}

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

    // Free Whisper BEFORE loading Kroko to avoid OOM (~244MB + 306MB = 550MB peak).
    // Whisper is no longer needed: Kroko handles ACTIVE streaming, and if streaming
    // fails mid-utterance the offline fallback can re-init Whisper on demand.
    console.log('[Pipeline] Releasing Whisper to free memory before Kroko engine load');
    await whisperService.release();

    // Native memory deallocation from sherpa-onnx destroy() is async — the JS
    // promise resolves before the native heap actually frees ~244MB. Without a
    // pause, loading Kroko engines on top of not-yet-freed Whisper memory causes
    // peak ~550MB → Android HWUI thread gets its mutexes destroyed → SIGABRT.
    console.log('[Pipeline] Waiting for native memory reclamation after Whisper release');
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check available memory before loading ~306MB of Kroko engines
    const availableMB = await memoryMonitor.getAvailableMB();
    console.log('[Pipeline] Available memory before Kroko load:', availableMB, 'MB');
    if (availableMB < 400) {
      console.warn('[Pipeline] Insufficient memory for Kroko engines (' + availableMB + 'MB < 400MB) — staying on offline pipeline');
      return;
    }

    await streamingPipeline.configure(langA, langB);
    console.log('[Pipeline] Streaming pipeline ready for', langA, '↔', langB);
  } catch (e) {
    console.error('[Pipeline] Streaming pipeline setup failed (falling back to offline):', e);
  }
}

// ── STT with fallback ─────────────────────────────────────────────────────────

/**
 * Transcribe via the resolved adapter, with transparent fallback to offline
 * when the online adapter fails AND the user is on 'auto'. Explicit 'online'
 * or 'offline' choices are respected — we never silently swap in those cases.
 *
 * On online failure we also poke the NetworkMonitor so its state flips to
 * 'offline' faster than the next scheduled probe would, preventing the next
 * utterance from re-hitting online and failing again.
 */
async function transcribeWithFallback(
  audioPath: string,
  language?: string,
): Promise<TranscriptionResult> {
  const adapter = resolveSttAdapter();
  try {
    return await adapter.transcribe(audioPath, language);
  } catch (e) {
    const { sttTransport } = useSettingsStore.getState();
    if (adapter.name === 'online' && sttTransport === 'auto') {
      console.warn('[Pipeline] Online STT failed, falling back to offline:', e);
      probeNetworkNow();
      return offlineSttAdapter.transcribe(audioPath, language);
    }
    throw e;
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
        const result = await transcribeWithFallback(utterance.audioPath, sourceLang);
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
      await flushPendingStreamingConfig();
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

    await flushPendingStreamingConfig();
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

  // ── STT: transcribe + language identification ───────────────────────────────
  // Adapter-routed (offline Whisper or online Voxtral) with transparent fallback
  // to offline when online fails in 'auto' mode. ML Kit text LID is the primary
  // signal — it's reliable when the transcription is correct. The adapter's
  // result.language is only a tiebreaker when ML Kit is unsure. A dedicated
  // audio LID model (ECAPA-TDNN or similar) is needed for production.
  const result = await transcribeWithFallback(audioPath);
  const text = result.text.trim();
  if (!text || isWhisperNoise(text)) return null;

  // Bail if the session was reset while we were transcribing
  if (discoveryGeneration !== genAtEntry) return null;

  const sttLang = (result.language || '').split('-')[0].toLowerCase();
  console.log('[Pipeline] Transcribed →', { text, sttLang, phase: discoveryPhase });

  // ML Kit text LID — primary signal for all phases
  const svc = await getTranslationService();
  const candidates = await svc.identifyLanguage(text).catch(() => []);
  const mlKitLang = (candidates[0]?.language ?? '').split('-')[0].toLowerCase();
  const mlKitConf = candidates[0]?.confidence ?? 0;

  if (discoveryGeneration !== genAtEntry) return null;
  console.log('[Pipeline] ML Kit LID →', { mlKitLang, mlKitConf });

  // Use ML Kit as primary. sttLang is only a tiebreaker when ML Kit is unsure.
  const topLang = mlKitConf >= 0.4 ? mlKitLang : (sttLang || mlKitLang);
  const topConf = mlKitConf >= 0.4 ? mlKitConf : (sttLang ? 0.6 : mlKitConf);

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
  // Audio LID (Silero lang_classifier_95) routes speakers when available.
  // It identifies the SPOKEN language from raw PCM — immune to Whisper's
  // translate bug (e.g. Spanish audio → English text still routes correctly).
  // Falls back to ML Kit text LID when audio LID is not loaded.
  const { personA, personB } = useSettingsStore.getState();
  const activeLangA = personA.language;
  const activeLangB = personB.language;

  let activeLang = topLang;
  let activeConf = topConf;

  if (audioLIDService.isLoaded) {
    const predictions = await audioLIDService.identifyLanguageFromFile(audioPath, 3);
    if (discoveryGeneration !== genAtEntry) return null;

    if (predictions.length > 0) {
      // Find the best match among the known language pair
      const matchA = predictions.find(p => p.language === activeLangA);
      const matchB = predictions.find(p => p.language === activeLangB);
      const confA = matchA?.confidence ?? 0;
      const confB = matchB?.confidence ?? 0;

      if (confA > 0 || confB > 0) {
        activeLang = confA >= confB ? activeLangA : activeLangB;
        activeConf = Math.max(confA, confB);
        console.log('[Pipeline] ACTIVE AudioLID →', {
          activeLang, activeConf: activeConf.toFixed(3),
          confA: confA.toFixed(3), confB: confB.toFixed(3),
          mlKit: topLang,
        });
      } else {
        console.log('[Pipeline] ACTIVE AudioLID: no match in known pair, falling back to ML Kit');
      }
    }
  }

  if (activeConf < ACTIVE_CONFIDENCE) {
    console.log('[Pipeline] ACTIVE: ignoring low-confidence detection (conf:', activeConf, ')');
    return null;
  }
  if (activeLang === activeLangA) {
    return {
      speakerId: 'person_a',
      transcribedText: text,
      sourceLang: activeLangA,
      targetLang: activeLangB,
    };
  }
  if (activeLang === activeLangB) {
    return {
      speakerId: 'person_b',
      transcribedText: text,
      sourceLang: activeLangB,
      targetLang: activeLangA,
    };
  }
  console.log('[Pipeline] ACTIVE: ignoring unknown language', activeLang,
    '(known:', activeLangA, '/', activeLangB, ')');
  return null;
}
