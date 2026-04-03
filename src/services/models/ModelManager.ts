import RNFS from 'react-native-fs';
import { useModelStore } from '../../store/modelStore';
import { whisperService } from '../stt/WhisperService';
import { zipvoiceService } from '../tts/ZipVoiceService';

// ── Whisper base multilingual Q8_0 — ~82MB ───────────────────────────────────
const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin';
const WHISPER_FILENAME = 'ggml-base-q8_0.bin';
const WHISPER_MIN_SIZE = 60 * 1024 * 1024; // 60MB

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

function modelPath(filename: string): string {
  return `${RNFS.DocumentDirectoryPath}/${filename}`;
}

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
    progressDivider: 1,
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

async function getAvailableMemoryMB(): Promise<number> {
  try {
    const { NativeModules } = await import('react-native');
    const mb: number = await NativeModules.ParlyMemory?.getAvailableMemoryMB?.();
    return mb ?? 4096;
  } catch {
    return 4096;
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export async function initModels(): Promise<void> {
  const store = useModelStore.getState();

  // ── Whisper (required) ────────────────────────────────────────────────────
  store.setWhisperStatus('downloading');
  try {
    await downloadFile(
      WHISPER_MODEL_URL,
      modelPath(WHISPER_FILENAME),
      WHISPER_MIN_SIZE,
      pct => store.setWhisperProgress(pct),
    );
    store.setWhisperStatus('loading');
    await whisperService.load(modelPath(WHISPER_FILENAME));
    store.setWhisperStatus('ready');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setWhisperStatus('error');
    store.setWhisperError(msg);
    throw e; // Whisper is required — propagate
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
