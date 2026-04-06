import * as RNFS from '@dr.pogodin/react-native-fs';
import { useModelStore } from '../../store/modelStore';
import { useSettingsStore } from '../../store/settingsStore';
import { whisperService } from '../stt/WhisperService';
import { canaryService } from '../stt/CanaryService';
import { zipvoiceService } from '../tts/ZipVoiceService';

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

  // ── Canary (optional — en/es/de/fr pairs; lazy-loaded when ACTIVE phase starts) ──
  // Only download files here. Engines are created lazily by canaryService.loadForPair()
  // when the actual language pair is discovered, so both engines are never held in RAM
  // simultaneously with Whisper for longer than the brief transition moment.
  const availableMBAfterWhisper = await getAvailableMemoryMB();
  if (availableMBAfterWhisper < 450) {
    store.setCanaryStatus('error');
    store.setCanaryError(`RAM insuficiente (${availableMBAfterWhisper}MB) — Canary no disponible.`);
  } else {
    store.setCanaryStatus('downloading');
    const canaryDir = `${RNFS.DocumentDirectoryPath}/${CANARY_MODEL_DIR}`;
    try {
      await downloadCanaryModel(canaryDir, pct => store.setCanaryProgress(pct));
      canaryService.setModelDir(canaryDir);
      store.setCanaryStatus('ready');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      store.setCanaryStatus('error');
      store.setCanaryError(msg);
      // Non-fatal — pipeline falls back to Whisper automatically
    }
  }

  // ── ZipVoice (optional) ───────────────────────────────────────────────────
  if (!ENABLE_ZIPVOICE) {
    store.setZipvoiceStatus('error');
    store.setZipvoiceError('ZipVoice deshabilitado — usando TTS del sistema.');
    return;
  }

  const availableMB = await getAvailableMemoryMB();
  if (availableMB < 500) {
    store.setZipvoiceStatus('error');
    store.setZipvoiceError(`RAM insuficiente (${availableMB}MB) — usando TTS del sistema.`);
    return;
  }

  const zipvoiceDir = `${RNFS.DocumentDirectoryPath}/${ZIPVOICE_MODEL_DIR}`;
  store.setZipvoiceStatus('downloading');
  try {
    await downloadZipvoiceModel(zipvoiceDir, pct => store.setZipvoiceProgress(pct));
    store.setZipvoiceStatus('loading');
    await zipvoiceService.load(zipvoiceDir);
    store.setZipvoiceStatus('ready');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setZipvoiceStatus('error');
    store.setZipvoiceError(msg);
    // Non-fatal — pipeline uses NativeTTS fallback automatically
  }
}
