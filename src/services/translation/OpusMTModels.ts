// OpusMT model inventory — Helsinki-NLP MarianMT ONNX INT8 models.
//
// Each model is a single language pair direction (~75-100MB).
// For EN/ES/FR/DE, we have 6 direct pairs (all involve EN).
// Non-EN pairs (es-fr, fr-de, es-de) use EN pivot (two translations).
//
// License: CC-BY 4.0 (commercial use permitted).

export interface OpusMTModelInfo {
  /** Source language code (BCP-47 base). */
  readonly src: string;
  /** Target language code (BCP-47 base). */
  readonly tgt: string;
  /** HuggingFace repo ID for the ONNX model. */
  readonly repo: string;
  /** Required files to download. */
  readonly files: readonly OpusMTFile[];
  /** Local directory name for this model. */
  readonly dirName: string;
}

export interface OpusMTFile {
  readonly name: string;
  readonly minSize: number;
  readonly sizeEstimate: number; // MB
}

// Standard MarianMT ONNX INT8 file set
const MARIAN_FILES: readonly OpusMTFile[] = [
  { name: 'encoder_model_quantized.onnx', minSize: 20 * 1024 * 1024, sizeEstimate: 35 },
  { name: 'decoder_model_quantized.onnx', minSize: 20 * 1024 * 1024, sizeEstimate: 40 },
  { name: 'source.spm',                   minSize: 500 * 1024,        sizeEstimate: 0.8 },
  { name: 'target.spm',                   minSize: 500 * 1024,        sizeEstimate: 0.8 },
  { name: 'vocab.json',                   minSize: 100 * 1024,        sizeEstimate: 0.5 },
  { name: 'config.json',                  minSize: 100,               sizeEstimate: 0.01 },
  { name: 'tokenizer_config.json',        minSize: 100,               sizeEstimate: 0.01 },
];

const HF_BASE = 'https://huggingface.co/Helsinki-NLP';

function model(src: string, tgt: string): OpusMTModelInfo {
  const repo = `opus-mt-${src}-${tgt}`;
  return {
    src,
    tgt,
    repo: `${HF_BASE}/${repo}`,
    files: MARIAN_FILES,
    dirName: `opus-mt-${src}-${tgt}`,
  };
}

/**
 * Direct translation models — each covers one language pair direction.
 * All 6 direct pairs involve English as source or target.
 */
export const OPUS_MT_MODELS: readonly OpusMTModelInfo[] = [
  model('en', 'es'),
  model('es', 'en'),
  model('en', 'fr'),
  model('fr', 'en'),
  model('en', 'de'),
  model('de', 'en'),
];

/** Per-model download size estimate in MB. */
export const OPUS_MT_MODEL_SIZE_MB = MARIAN_FILES.reduce((s, f) => s + f.sizeEstimate, 0);

/**
 * Find the direct model for a language pair, or null if pivot is needed.
 */
export function findDirectModel(src: string, tgt: string): OpusMTModelInfo | null {
  const s = src.split('-')[0].toLowerCase();
  const t = tgt.split('-')[0].toLowerCase();
  return OPUS_MT_MODELS.find(m => m.src === s && m.tgt === t) ?? null;
}

/**
 * Determine if a pair needs EN pivot (neither side is English).
 * Returns the two models needed for pivot, or null if direct exists.
 */
export function getPivotModels(src: string, tgt: string): readonly [OpusMTModelInfo, OpusMTModelInfo] | null {
  const s = src.split('-')[0].toLowerCase();
  const t = tgt.split('-')[0].toLowerCase();

  // Direct model exists — no pivot needed
  if (findDirectModel(s, t)) return null;

  // Pivot: src → en, then en → tgt
  const srcToEn = findDirectModel(s, 'en');
  const enToTgt = findDirectModel('en', t);

  if (srcToEn && enToTgt) return [srcToEn, enToTgt] as const;

  return null; // Unsupported pair
}

/**
 * Get all models required for a language pair (1 for direct, 2 for pivot).
 */
export function getRequiredModels(src: string, tgt: string): readonly OpusMTModelInfo[] {
  const direct = findDirectModel(src, tgt);
  if (direct) return [direct];

  const pivot = getPivotModels(src, tgt);
  if (pivot) return pivot;

  return [];
}

/**
 * Get all models needed for a full bidirectional language set.
 * For EN/ES/FR/DE: returns all 6 direct EN pairs.
 */
export function getAllModelsForLanguages(languages: readonly string[]): readonly OpusMTModelInfo[] {
  const langs = languages.map(l => l.split('-')[0].toLowerCase());
  const needed = new Set<string>();
  const result: OpusMTModelInfo[] = [];

  for (const src of langs) {
    for (const tgt of langs) {
      if (src === tgt) continue;
      for (const m of getRequiredModels(src, tgt)) {
        const key = `${m.src}-${m.tgt}`;
        if (!needed.has(key)) {
          needed.add(key);
          result.push(m);
        }
      }
    }
  }

  return result;
}
