import * as RNFS from '@dr.pogodin/react-native-fs';
import { useModelStore } from '../../store/modelStore';
import { useSettingsStore } from '../../store/settingsStore';
import { whisperService } from '../stt/WhisperService';
import { canaryService } from '../stt/CanaryService';
import { streamingSTTService, KROKO_LANGUAGES, isKrokoLanguage } from '../stt/StreamingSTTService';
import { zipvoiceService } from '../tts/ZipVoiceService';
import { sileroVADService } from '../audio/SileroVADService';
import { setSileroModelPath } from '../audio/VADController';
import { audioLIDService } from '../lid/AudioLIDService';
import { getAllModelsForLanguages, OPUS_MT_MODEL_SIZE_MB } from '../translation/OpusMTModels';
import type { OpusMTModelInfo } from '../translation/OpusMTModels';
import { resetTranslationService } from '../translation/TranslationServiceSingleton';

// ── Sherpa-ONNX Whisper small multilingual int8 — ~244MB ─────────────────────
// Significantly better WER and language detection than base.
// ⚠️  Verify these URLs before production — check:
//     https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small
const WHISPER_HF_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main';
const WHISPER_MODEL_DIR = 'sherpa-onnx-whisper-small';

// Old base model dir — cleaned up on first run of the small model
const WHISPER_OLD_DIR = 'sherpa-onnx-whisper-base';

// ── NeMo Canary 180M Flash — ~180MB int8 ──────────────────────────────────────
// Pure multilingual ASR for en/es/de/fr — physically cannot translate.
// ⚠️  Verify these URLs before production — check:
//     https://huggingface.co/k2-fsa/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8
const CANARY_HF_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/resolve/main';
const CANARY_MODEL_DIR = 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8';

interface CanaryFile {
  readonly name: string;
  readonly minSize: number;
  readonly sizeEstimate: number; // MB
}

// File list verified from scripts/nemo/canary/run_180m_flash.sh in k2-fsa/sherpa-onnx.
const CANARY_FILES: CanaryFile[] = [
  { name: 'encoder.int8.onnx', minSize: 120 * 1024 * 1024, sizeEstimate: 133 },
  { name: 'decoder.int8.onnx', minSize: 65  * 1024 * 1024, sizeEstimate: 74  },
  { name: 'tokens.txt',        minSize: 40  * 1024,         sizeEstimate: 0.1 },
];

const TOTAL_CANARY_MB = CANARY_FILES.reduce((s, f) => s + f.sizeEstimate, 0);

interface WhisperFile {
  readonly name: string;
  readonly minSize: number;
  readonly sizeEstimate: number; // MB, for progress weighting
}

const WHISPER_FILES: WhisperFile[] = [
  { name: 'small-encoder.int8.onnx', minSize: 80  * 1024 * 1024, sizeEstimate: 95  },
  { name: 'small-decoder.int8.onnx', minSize: 130 * 1024 * 1024, sizeEstimate: 148 },
  { name: 'small-tokens.txt',        minSize: 500 * 1024,         sizeEstimate: 0.8 },
];

const TOTAL_WHISPER_MB = WHISPER_FILES.reduce((s, f) => s + f.sizeEstimate, 0);

// ── ZipVoice distill-int8 — ~104MB total ─────────────────────────────────────
// Individual ONNX files hosted on HuggingFace k2-fsa organization.
// ⚠️  Verify these URLs before production — check:
//     https://huggingface.co/k2-fsa/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia
const ZIPVOICE_HF_BASE =
  'https://huggingface.co/k2-fsa/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia/resolve/main';
const ZIPVOICE_MODEL_DIR = 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia';

interface ZipvoiceFile {
  readonly name: string;
  readonly minSize: number;
  readonly sizeEstimate: number; // for progress weighting
}

const ZIPVOICE_FILES: ZipvoiceFile[] = [
  { name: 'encoder.int8.onnx', minSize: 20 * 1024 * 1024, sizeEstimate: 28 },
  { name: 'decoder.int8.onnx', minSize: 50 * 1024 * 1024, sizeEstimate: 68 },
  { name: 'vocos_24khz.onnx',  minSize: 1  * 1024 * 1024, sizeEstimate: 5  },
  { name: 'tokens.txt',        minSize: 100,               sizeEstimate: 0.1 },
  { name: 'lexicon.txt',       minSize: 100,               sizeEstimate: 0.1 },
];

const TOTAL_ZIPVOICE_MB = ZIPVOICE_FILES.reduce((s, f) => s + f.sizeEstimate, 0);

// Set to false to skip ZipVoice and always use OS TTS fallback
const ENABLE_ZIPVOICE = true;

// ── Kroko streaming Zipformer INT8 — ~147MB per language ─────────────────────
// Per-language streaming ASR models (Zipformer2 + Transducer).
// Source: https://huggingface.co/hudaiapa88/sherpa-stt-onnx
const KROKO_HF_BASE =
  'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main';
const KROKO_MODEL_DIR = 'streaming-kroko';
const KROKO_VARIANT = 'kroko_64l'; // 64-layer: ~200ms latency, ~5% WER, 1GB RAM

interface KrokoFile {
  readonly name: string;
  readonly minSize: number;
  readonly sizeEstimate: number; // MB
}

// Verified file sizes from HuggingFace (es/kroko_64l):
//   encoder.int8.onnx = 153 MB, decoder.int8.onnx = 606 KB,
//   joiner.int8.onnx = 337 KB, tokens.txt = 7 KB
const KROKO_FILES: KrokoFile[] = [
  { name: 'encoder.int8.onnx', minSize: 50 * 1024 * 1024,  sizeEstimate: 153  },
  { name: 'decoder.int8.onnx', minSize: 100 * 1024,         sizeEstimate: 0.6  },
  { name: 'joiner.int8.onnx',  minSize: 100 * 1024,         sizeEstimate: 0.3  },
  { name: 'tokens.txt',        minSize: 1   * 1024,         sizeEstimate: 0.01 },
];

const TOTAL_KROKO_PER_LANG_MB = KROKO_FILES.reduce((s, f) => s + f.sizeEstimate, 0);

// ── Silero VAD — ~1.8MB ──────────────────────────────────────────────────────
// Neural VAD model — MUST use the sherpa-onnx-compatible version, not upstream snakers4.
// The upstream silero_vad.onnx has a different graph structure that causes native crashes
// (pthread_mutex_lock on destroyed mutex) when loaded via sherpa-onnx's Vad class.
const SILERO_VAD_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const SILERO_VAD_FILENAME = 'silero_vad.onnx';
const SILERO_VAD_MIN_SIZE = 1 * 1024 * 1024; // ~1.8MB

// ── Silero Language Identification — ~16.2MB ─────────────────────────────────
// Audio-based LID: identifies spoken language from raw PCM, immune to Whisper
// translate bug. 95 languages, raw 16kHz input, no FBank preprocessing needed.
const SILERO_LID_HF_BASE =
  'https://huggingface.co/deepghs/silero-lang95-onnx/resolve/main';
const SILERO_LID_DIR = 'silero-lid';
const SILERO_LID_MODEL = 'lang_classifier_95.onnx';
const SILERO_LID_DICT = 'lang_dict_95.json';
const SILERO_LID_MIN_SIZE = 15 * 1024 * 1024; // ~16.2MB

// ── OpusMT Helsinki-NLP MarianMT ONNX INT8 — ~75-100MB per pair ─────────────
// Direct translation models for EN↔{ES,FR,DE}. Non-EN pairs pivot through EN.
// Source: https://huggingface.co/Helsinki-NLP
const OPUS_MT_BASE_DIR = 'opus-mt';
const OPUS_MT_HF_BASE = 'https://huggingface.co/Helsinki-NLP';

async function downloadOpusMTModel(
  model: OpusMTModelInfo,
  baseDir: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  const modelDir = `${baseDir}/${model.dirName}`;
  await RNFS.mkdir(modelDir);

  let completedMB = 0;
  const totalMB = OPUS_MT_MODEL_SIZE_MB;

  for (const file of model.files) {
    // HuggingFace resolve URL for ONNX models
    const url = `${OPUS_MT_HF_BASE}/${model.dirName}/resolve/main/onnx/${file.name}`;
    const dest = `${modelDir}/${file.name}`;

    await downloadFile(url, dest, file.minSize, filePct => {
      const fileMB = file.sizeEstimate * (filePct / 100);
      onProgress(Math.round(((completedMB + fileMB) / totalMB) * 100));
    });

    completedMB += file.sizeEstimate;
    onProgress(Math.round((completedMB / totalMB) * 100));
  }
}

async function downloadOpusMTModels(
  languages: readonly string[],
  onProgress: (pct: number) => void,
): Promise<void> {
  const baseDir = `${RNFS.DocumentDirectoryPath}/${OPUS_MT_BASE_DIR}`;
  await RNFS.mkdir(baseDir);

  const models = getAllModelsForLanguages(languages);
  if (models.length === 0) return;

  const totalMB = OPUS_MT_MODEL_SIZE_MB * models.length;
  let completedMB = 0;

  for (const model of models) {
    await downloadOpusMTModel(model, baseDir, modelPct => {
      const modelMB = OPUS_MT_MODEL_SIZE_MB * (modelPct / 100);
      onProgress(Math.round(((completedMB + modelMB) / totalMB) * 100));
    });
    completedMB += OPUS_MT_MODEL_SIZE_MB;
    onProgress(Math.round((completedMB / totalMB) * 100));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function downloadFile(
  url: string,
  destPath: string,
  minSize: number,
  onProgress: (pct: number) => void,
): Promise<void> {
  if (await RNFS.exists(destPath)) {
    const { size } = await RNFS.stat(destPath);
    if (size >= minSize) {
      onProgress(100);
      return;
    }
    console.warn(`[ModelManager] Incomplete file (${size}B), re-downloading: ${destPath}`);
    await RNFS.unlink(destPath);
  }

  const result = await RNFS.downloadFile({
    fromUrl: url,
    toFile: destPath,
    progress: ({ bytesWritten, contentLength }) => {
      onProgress(contentLength > 0 ? Math.round((bytesWritten / contentLength) * 100) : 0);
    },
    progressDivider: 5,
    background: true,
    discretionary: true,
  }).promise;

  if (result.statusCode !== 200) {
    await RNFS.unlink(destPath).catch(() => {});
    throw new Error(`HTTP ${result.statusCode} downloading ${url}`);
  }
}

async function downloadZipvoiceModel(
  modelDir: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  await RNFS.mkdir(modelDir);

  let completedMB = 0;

  for (const file of ZIPVOICE_FILES) {
    const url = `${ZIPVOICE_HF_BASE}/${file.name}`;
    const dest = `${modelDir}/${file.name}`;

    await downloadFile(url, dest, file.minSize, filePct => {
      const fileMB = file.sizeEstimate * (filePct / 100);
      onProgress(
        Math.round(((completedMB + fileMB) / TOTAL_ZIPVOICE_MB) * 100),
      );
    });

    completedMB += file.sizeEstimate;
    onProgress(Math.round((completedMB / TOTAL_ZIPVOICE_MB) * 100));
  }
}

async function downloadCanaryModel(
  modelDir: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  await RNFS.mkdir(modelDir);

  let completedMB = 0;

  for (const file of CANARY_FILES) {
    const url = `${CANARY_HF_BASE}/${file.name}`;
    const dest = `${modelDir}/${file.name}`;

    await downloadFile(url, dest, file.minSize, filePct => {
      const fileMB = file.sizeEstimate * (filePct / 100);
      onProgress(
        Math.round(((completedMB + fileMB) / TOTAL_CANARY_MB) * 100),
      );
    });

    completedMB += file.sizeEstimate;
    onProgress(Math.round((completedMB / TOTAL_CANARY_MB) * 100));
  }
}

async function downloadKrokoLanguage(
  baseDir: string,
  lang: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  const langDir = `${baseDir}/${lang}`;
  await RNFS.mkdir(langDir);

  let completedMB = 0;

  for (const file of KROKO_FILES) {
    const url = `${KROKO_HF_BASE}/${lang}/${KROKO_VARIANT}/${file.name}`;
    const dest = `${langDir}/${file.name}`;

    await downloadFile(url, dest, file.minSize, filePct => {
      const fileMB = file.sizeEstimate * (filePct / 100);
      onProgress(
        Math.round(((completedMB + fileMB) / TOTAL_KROKO_PER_LANG_MB) * 100),
      );
    });

    completedMB += file.sizeEstimate;
    onProgress(Math.round((completedMB / TOTAL_KROKO_PER_LANG_MB) * 100));
  }
}

/**
 * Download Kroko streaming models for a set of languages.
 * Called during init for all Kroko-supported languages configured in settings.
 */
async function downloadKrokoModels(
  baseDir: string,
  languages: readonly string[],
  onProgress: (pct: number) => void,
): Promise<void> {
  await RNFS.mkdir(baseDir);

  const krokoLangs = languages
    .map(l => l.split('-')[0].toLowerCase())
    .filter(isKrokoLanguage);

  // Deduplicate
  const uniqueLangs = [...new Set(krokoLangs)];
  if (uniqueLangs.length === 0) return;

  const totalMB = TOTAL_KROKO_PER_LANG_MB * uniqueLangs.length;
  let completedMB = 0;

  for (const lang of uniqueLangs) {
    await downloadKrokoLanguage(baseDir, lang, langPct => {
      const langMB = TOTAL_KROKO_PER_LANG_MB * (langPct / 100);
      onProgress(Math.round(((completedMB + langMB) / totalMB) * 100));
    });
    completedMB += TOTAL_KROKO_PER_LANG_MB;
    onProgress(Math.round((completedMB / totalMB) * 100));
  }
}

async function getAvailableMemoryMB(): Promise<number> {
  try {
    const { NativeModules } = await import('react-native');
    const mb: number | undefined = await NativeModules.ParlyMemory?.getAvailableMemoryMB?.();
    if (mb == null) {
      console.warn('[ModelManager] ParlyMemory module unavailable, assuming constrained memory');
      return 0; // skip ZipVoice when we can't measure — safer than assuming 512MB
    }
    return mb;
  } catch {
    return 0;
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Download Kroko streaming model for a specific language on demand.
 * Called when a new language is discovered in ACTIVE phase transition.
 */
let _krokoDownloadLock: Promise<void> | null = null;

/**
 * Download Kroko streaming model for a specific language on demand.
 * Called when a new language is discovered in ACTIVE phase transition.
 * Serialized to prevent concurrent downloads to the same directory.
 */
export async function downloadKrokoForLanguage(lang: string): Promise<void> {
  const normalized = lang.split('-')[0].toLowerCase();
  if (!isKrokoLanguage(normalized)) return;

  // Serialize concurrent calls
  while (_krokoDownloadLock) {
    await _krokoDownloadLock;
  }

  const krokoDir = `${RNFS.DocumentDirectoryPath}/${KROKO_MODEL_DIR}`;
  await RNFS.mkdir(krokoDir);

  // Check ALL required files exist with minimum sizes (not just encoder)
  const langDir = `${krokoDir}/${normalized}`;
  let allPresent = true;
  for (const file of KROKO_FILES) {
    const filePath = `${langDir}/${file.name}`;
    if (await RNFS.exists(filePath)) {
      const { size } = await RNFS.stat(filePath);
      if (size < file.minSize) {
        allPresent = false;
        break;
      }
    } else {
      allPresent = false;
      break;
    }
  }

  if (allPresent) {
    console.log(`[ModelManager] Kroko ${normalized} already downloaded`);
    streamingSTTService.setModelBaseDir(krokoDir);
    return;
  }

  console.log(`[ModelManager] Downloading Kroko ${normalized}...`);
  const store = useModelStore.getState();
  store.setKrokoStatus('downloading');

  let resolve: () => void;
  _krokoDownloadLock = new Promise<void>(r => { resolve = r; });

  try {
    await downloadKrokoLanguage(krokoDir, normalized, pct => store.setKrokoProgress(pct));
    streamingSTTService.setModelBaseDir(krokoDir);
    store.setKrokoStatus('ready');
    console.log(`[ModelManager] Kroko ${normalized} download complete`);
  } finally {
    _krokoDownloadLock = null;
    resolve!();
  }
}

let _initPromise: Promise<void> | null = null;

export async function initModels(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = _initModelsImpl();
  try {
    await _initPromise;
  } finally {
    _initPromise = null;
  }
}

async function _initModelsImpl(): Promise<void> {
  const store = useModelStore.getState();

  // ── Whisper (required) ────────────────────────────────────────────────────
  store.setWhisperStatus('downloading');
  const whisperDir = `${RNFS.DocumentDirectoryPath}/${WHISPER_MODEL_DIR}`;
  try {
    await RNFS.mkdir(whisperDir);
    let completedMB = 0;
    for (const file of WHISPER_FILES) {
      const url = `${WHISPER_HF_BASE}/${file.name}`;
      const dest = `${whisperDir}/${file.name}`;
      await downloadFile(url, dest, file.minSize, filePct => {
        const fileMB = file.sizeEstimate * (filePct / 100);
        store.setWhisperProgress(
          Math.round(((completedMB + fileMB) / TOTAL_WHISPER_MB) * 100),
        );
      });
      completedMB += file.sizeEstimate;
      store.setWhisperProgress(Math.round((completedMB / TOTAL_WHISPER_MB) * 100));
    }
    store.setWhisperStatus('loading');
    await whisperService.load(whisperDir);
    store.setWhisperStatus('ready');

    // Clean up old base model to free ~161MB
    const oldDir = `${RNFS.DocumentDirectoryPath}/${WHISPER_OLD_DIR}`;
    RNFS.exists(oldDir)
      .then(exists => exists ? RNFS.unlink(oldDir) : Promise.resolve())
      .catch(() => {});
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setWhisperStatus('error');
    store.setWhisperError(msg);
    throw e; // Whisper is required — propagate
  }

  // ── Silero VAD — via direct ONNX Runtime (bypasses sherpa-onnx Vad class) ───
  // The sherpa-onnx Vad() constructor SIGABRTs on the QNN build. SileroVADDirect
  // uses ONNX Runtime Java API directly (same pattern as OpusMTModule) to avoid this.
  const sileroPath = `${RNFS.DocumentDirectoryPath}/${SILERO_VAD_FILENAME}`;
  try {
    await downloadFile(SILERO_VAD_URL, sileroPath, SILERO_VAD_MIN_SIZE, () => {});
    await sileroVADService.load(sileroPath);
    setSileroModelPath(sileroPath);
    console.log('[ModelManager] Silero VAD ready (direct ONNX Runtime)');
  } catch (e) {
    console.warn('[ModelManager] Silero VAD download/load failed — energy VAD will be used:', e);
  }

  // ── Silero LID — audio-based language identification (16.2MB) ───────────────
  // Identifies spoken language from raw PCM. Runs in ACTIVE phase before Whisper
  // to fix the translate bug (Whisper translating Spanish→English text).
  const lidDir = `${RNFS.DocumentDirectoryPath}/${SILERO_LID_DIR}`;
  try {
    await RNFS.mkdir(lidDir);
    const modelDest = `${lidDir}/${SILERO_LID_MODEL}`;
    const dictDest = `${lidDir}/${SILERO_LID_DICT}`;
    await downloadFile(`${SILERO_LID_HF_BASE}/${SILERO_LID_MODEL}`, modelDest, SILERO_LID_MIN_SIZE, () => {});
    await downloadFile(`${SILERO_LID_HF_BASE}/${SILERO_LID_DICT}`, dictDest, 100, () => {});
    await audioLIDService.load(modelDest, dictDest);
    console.log('[ModelManager] Silero LID ready (audio-based language identification)');
  } catch (e) {
    console.warn('[ModelManager] Silero LID download/load failed — ML Kit text LID will be used:', e);
  }

  // ── Canary — DISABLED (v3.0: replaced by audio-first LID + Whisper) ────────
  // Canary (207MB) + Whisper (244MB) together cause OOM/SIGABRT on mid-range
  // devices. Audio-first LID (Phase 2) will eliminate this workaround entirely.
  store.setCanaryStatus('error');
  store.setCanaryError('Canary deshabilitado — v3.0 usa Whisper + ML Kit LID.');

  // ── Kroko streaming — DISABLED (v3.0: will be replaced by lighter Zipformer) ─
  // Kroko models are 153MB/lang — too heavy alongside Whisper on 6GB devices.
  store.setKrokoStatus('error');
  store.setKrokoError('Kroko deshabilitado — v3.0 usará Zipformer ligero.');

  // ── OpusMT (optional — offline translation for EN↔{ES,FR,DE}) ──────────────
  // Download models for the configured language pair.
  const { personA, personB } = useSettingsStore.getState();
  const opusMTLangs = [personA.language, personB.language];
  store.setOpusMTStatus('downloading');
  try {
    await downloadOpusMTModels(opusMTLangs, pct => store.setOpusMTProgress(pct));
    store.setOpusMTStatus('ready');
    // Reset singleton so next call picks up OpusMT instead of ML Kit
    resetTranslationService();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setOpusMTStatus('error');
    store.setOpusMTError(msg);
    // Non-fatal — pipeline falls back to ML Kit translation
  }

  // ── ZipVoice — DISABLED (v3.0: will be replaced by Piper/Kokoro TTS) ─────
  // ZipVoice (104MB) is too heavy. Piper (~30MB) will replace it in Phase 3.
  store.setZipvoiceStatus('error');
  store.setZipvoiceError('ZipVoice deshabilitado — v3.0 usará Piper TTS.');
}
