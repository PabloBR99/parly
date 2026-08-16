#!/usr/bin/env node
//
// voxtral-wer-bench — measure the transcript, not the latency.
//
// This app has three rounds of on-device latency measurement behind it, broken
// down per link of the chain, and had exactly zero measurements of accuracy.
// That asymmetry is how `target_streaming_delay_ms` came to be lowered to 320
// with a comment calling the accuracy cost "marginal": the latency it bought
// was measured to the millisecond, and the thing it spent was guessed at. This
// script exists so the next such decision is made with numbers on both sides.
//
// What it does: replays real recordings through the real Voxtral realtime
// socket at wallclock speed — the same protocol, pacing and flush behaviour the
// app uses — under each combination of settings you ask for, and scores the
// transcripts against your own references.
//
// Usage:
//   MISTRAL_API_KEY=… node scripts/voxtral-wer-bench.mjs --dir ./bench-audio
//
//   --dir <path>        Directory of NAME.wav + NAME.txt pairs (the .txt is
//                       the reference transcript). Required.
//   --delay 320,480     Streaming delays to compare (ms). Default: 320,480.
//   --agc on,off        Level normalisation before sending. Default: off,on.
//   --endpoint <modes>  How segments are closed. Default: end,pause,settled.
//                         end     — one segment, flushed when the file ends.
//                         pause   — flush at every silence ≥280 ms, the moment
//                                   it is detected. What the app did before.
//                         settled — flush at the same silences, but only once
//                                   the transcript has been quiet for 140 ms.
//                                   What the app does now.
//   --names "A,B,C"     Also score these names specifically.
//   --model <id>        Default: voxtral-mini-transcribe-realtime-2602.
//   --runs <n>          Repeats per configuration (default 1). The server is
//                       not deterministic; 2-3 runs make small gaps readable.
//   --verbose           Print every hypothesis, not just the summary.
//
// Recording the fixtures: record the way the app is actually used — the phone
// flat on a table between two people, at normal conversational speed, with
// whatever background the room has. A bench made of clean close-mic audio will
// tell you every setting is fine, which is exactly the answer that sent us
// here. Include the names that get mangled. Twenty utterances is enough to see
// a real difference; five is not.
//
// WAV files must be 16-bit PCM. Sample rate and channel count are converted if
// needed, but recording at 16 kHz mono avoids the question.

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 100;

// Endpointing constants, mirrored from the app so the bench measures what ships.
// ConversationOrchestrator: PARTIAL_SETTLED_MS. SileroVadService: the pause
// hint at 280 ms, and the entry/sustain RMS thresholds.
const PAUSE_HINT_MS = 280;
const PARTIAL_SETTLED_MS = 140;
const VAD_ENTRY_RMS = 0.05;
const VAD_SUSTAIN_RMS = VAD_ENTRY_RMS * 0.4;
const VAD_FRAME = 512;

// SpeechAgc, mirrored. Kept in sync by hand — src/services/audio/SpeechAgc.ts
// is the source of truth, and these five numbers are the whole of it.
const AGC = {
  targetDbfs: -21,
  maxGainDb: 15,
  minGainDb: -6,
  floorDbfs: -55,
  upMs: 1_200,
  downMs: 180,
};

// ── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    dir: null,
    delay: [320, 480],
    agc: [false, true],
    endpoint: ['end', 'pause', 'settled'],
    names: [],
    model: DEFAULT_MODEL,
    runs: 1,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dir') out.dir = next();
    else if (a === '--delay') out.delay = next().split(',').map((n) => parseInt(n, 10));
    else if (a === '--agc') out.agc = next().split(',').map((v) => v === 'on' || v === 'true');
    else if (a === '--endpoint') out.endpoint = next().split(',');
    else if (a === '--names') out.names = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') out.model = next();
    else if (a === '--runs') out.runs = parseInt(next(), 10);
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return out;
}

function printHelp() {
  const header = fs.readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('//'))
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n');
  console.log(header);
}

// ── WAV ──────────────────────────────────────────────────────────────────────

/** Read a 16-bit PCM WAV into mono Int16 at 16 kHz. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`${path.basename(file)}: missing fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`${path.basename(file)}: only 16-bit PCM is supported (got format=${fmt.format} bits=${fmt.bits})`);
  }

  const interleaved = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  const mono = fmt.channels === 1 ? interleaved : downmix(interleaved, fmt.channels);
  return fmt.sampleRate === SAMPLE_RATE ? mono : resample(mono, fmt.sampleRate, SAMPLE_RATE);
}

function downmix(pcm, channels) {
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c];
    out[i] = (sum / channels) | 0;
  }
  return out;
}

/** Linear resample. Good enough for a bench; record at 16 kHz for real work. */
function resample(pcm, from, to) {
  const ratio = from / to;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = (pcm[i0] * (1 - t) + pcm[i1] * t) | 0;
  }
  return out;
}

// ── Level normalisation (mirror of SpeechAgc) ────────────────────────────────

function applyAgc(pcm) {
  const out = new Int16Array(pcm.length);
  const chunk = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000);
  let gainDb = 0;
  let applied = 1;
  for (let start = 0; start < pcm.length; start += chunk) {
    const end = Math.min(pcm.length, start + chunk);
    let sumSquares = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      sumSquares += pcm[i] * pcm[i];
      const abs = Math.abs(pcm[i]);
      if (abs > peak) peak = abs;
    }
    const n = end - start;
    const rms = Math.sqrt(sumSquares / n) / 32768;
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    if (dbfs > AGC.floorDbfs) {
      const desired = Math.min(AGC.maxGainDb, Math.max(AGC.minGainDb, AGC.targetDbfs - dbfs));
      const tau = desired < gainDb ? AGC.downMs : AGC.upMs;
      gainDb += (desired - gainDb) * (1 - Math.exp((-n / SAMPLE_RATE) * 1000 / tau));
    }
    let target = Math.pow(10, gainDb / 20);
    if (peak > 0) target = Math.min(target, 32000 / peak);
    const step = n > 1 ? (target - applied) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const v = pcm[start + i] * (applied + step * i);
      out[start + i] = v > 32000 ? 32000 : v < -32000 ? -32000 : v | 0;
    }
    applied = target;
  }
  return out;
}

// ── Pause detection (mirror of the VAD's two thresholds) ─────────────────────

/** Sample offsets where the app's pause hint would fire, one per silence. */
function pauseOffsets(pcm) {
  const offsets = [];
  let speaking = false;
  let quietSince = -1;
  let firedForThisPause = false;
  for (let start = 0; start + VAD_FRAME <= pcm.length; start += VAD_FRAME) {
    let sumSquares = 0;
    for (let i = start; i < start + VAD_FRAME; i++) sumSquares += pcm[i] * pcm[i];
    const rms = Math.sqrt(sumSquares / VAD_FRAME) / 32768;
    const threshold = speaking ? VAD_SUSTAIN_RMS : VAD_ENTRY_RMS;
    if (rms >= threshold) {
      speaking = true;
      quietSince = -1;
      firedForThisPause = false;
    } else if (speaking) {
      if (quietSince < 0) quietSince = start;
      const quietMs = ((start + VAD_FRAME - quietSince) / SAMPLE_RATE) * 1000;
      if (!firedForThisPause && quietMs >= PAUSE_HINT_MS) {
        offsets.push(start + VAD_FRAME);
        firedForThisPause = true;
      }
    }
  }
  return offsets;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** Case, punctuation and spacing are the recogniser's to tidy; words are not. */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?;:¿¡"“”'’()\[\]…—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  const n = normalize(text);
  return n.length === 0 ? [] : n.split(' ');
}

/** Levenshtein over words: substitutions + insertions + deletions. */
function editDistance(a, b) {
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** How many of the reference's occurrences of each name survived. */
function nameScore(reference, hypothesis, names) {
  let expected = 0;
  let found = 0;
  const refWords = words(reference);
  const hypWords = words(hypothesis);
  for (const name of names) {
    const parts = words(name);
    if (parts.length === 0) continue;
    const count = (haystack) => {
      let n = 0;
      for (let i = 0; i + parts.length <= haystack.length; i++) {
        if (parts.every((p, k) => haystack[i + k] === p)) n++;
      }
      return n;
    };
    const want = count(refWords);
    if (want === 0) continue;
    expected += want;
    found += Math.min(want, count(hypWords));
  }
  return { expected, found };
}

// ── One transcription ────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encodeChunk(pcm, from, to) {
  return Buffer.from(pcm.buffer, pcm.byteOffset + from * 2, (to - from) * 2).toString('base64');
}

/**
 * Replay one recording through the realtime socket and return the transcript
 * the app would have assembled from it.
 */
async function transcribe(pcm, { delay, endpoint, model, apiKey }) {
  const ws = new WebSocket(`${ENDPOINT}?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let segments = [];
  let accumulated = '';
  let lastDeltaAt = 0;
  let pendingDone = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 10_000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
          target_streaming_delay_ms: delay,
        },
      }));
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`socket error: ${e.message ?? e}`)); });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'session.created' || msg.type === 'session.updated') {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (msg.type === 'transcription.text.delta') {
        accumulated += msg.text ?? '';
        lastDeltaAt = Date.now();
        return;
      }
      if (msg.type === 'transcription.done') {
        segments.push((msg.text ?? accumulated).trim());
        accumulated = '';
        pendingDone?.();
        pendingDone = null;
        return;
      }
      if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(JSON.stringify(msg.error)));
      }
    });
  });

  const flushPoints = endpoint === 'end' ? [] : pauseOffsets(pcm);
  const samplesPerChunk = (SAMPLE_RATE * CHUNK_MS) / 1000;
  let nextFlush = 0;

  for (let off = 0; off < pcm.length; off += samplesPerChunk) {
    const end = Math.min(off + samplesPerChunk, pcm.length);
    ws.send(JSON.stringify({ type: 'input_audio.append', audio: encodeChunk(pcm, off, end) }));
    await sleep(CHUNK_MS); // vLLM rejects audio arriving faster than wallclock

    while (nextFlush < flushPoints.length && flushPoints[nextFlush] <= end) {
      nextFlush++;
      if (endpoint === 'settled') {
        // What the app does now: hold the flush until the transcript has been
        // quiet for PARTIAL_SETTLED_MS, so the cut cannot land inside words the
        // server is still emitting.
        while (Date.now() - lastDeltaAt < PARTIAL_SETTLED_MS) await sleep(20);
      }
      const answered = new Promise((r) => { pendingDone = r; });
      ws.send(JSON.stringify({ type: 'input_audio.flush' }));
      await Promise.race([answered, sleep(4_000)]);
    }
  }

  const answered = new Promise((r) => { pendingDone = r; });
  ws.send(JSON.stringify({ type: 'input_audio.flush' }));
  await Promise.race([answered, sleep(6_000)]);
  ws.send(JSON.stringify({ type: 'input_audio.end' }));
  ws.close();

  const tail = accumulated.trim();
  if (tail.length > 0) segments.push(tail);
  return segments.filter(Boolean).join(' ');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.error('Set MISTRAL_API_KEY before running the bench.');
    process.exit(1);
  }
  if (!opts.dir) {
    console.error('Pass --dir <directory of NAME.wav + NAME.txt pairs>. --help for details.');
    process.exit(1);
  }

  const files = fs.readdirSync(opts.dir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .sort()
    .map((f) => {
      const base = path.join(opts.dir, f.replace(/\.wav$/i, ''));
      const ref = `${base}.txt`;
      if (!fs.existsSync(ref)) throw new Error(`${f} has no reference transcript (${path.basename(ref)})`);
      return { name: f, pcm: readWav(path.join(opts.dir, f)), reference: fs.readFileSync(ref, 'utf8').trim() };
    });

  if (files.length === 0) {
    console.error(`No .wav files in ${opts.dir}`);
    process.exit(1);
  }

  const totalSeconds = files.reduce((s, f) => s + f.pcm.length / SAMPLE_RATE, 0);
  const configs = [];
  for (const delay of opts.delay) {
    for (const agc of opts.agc) {
      for (const endpoint of opts.endpoint) configs.push({ delay, agc, endpoint });
    }
  }

  console.log(`${files.length} recordings, ${totalSeconds.toFixed(0)} s of audio`);
  console.log(`${configs.length} configuration(s) × ${opts.runs} run(s) — roughly ${
    Math.ceil((totalSeconds * configs.length * opts.runs) / 60)
  } min of wallclock, since audio is replayed in real time.\n`);

  const rows = [];
  for (const config of configs) {
    const label = `delay=${config.delay} agc=${config.agc ? 'on' : 'off'} endpoint=${config.endpoint}`;
    let errors = 0;
    let refWords = 0;
    let namesExpected = 0;
    let namesFound = 0;

    for (let run = 0; run < opts.runs; run++) {
      for (const file of files) {
        const pcm = config.agc ? applyAgc(file.pcm) : file.pcm;
        let hypothesis;
        try {
          hypothesis = await transcribe(pcm, { ...config, model: opts.model, apiKey });
        } catch (e) {
          console.error(`  ! ${file.name} under ${label}: ${e.message}`);
          continue;
        }
        const ref = words(file.reference);
        const hyp = words(hypothesis);
        const distance = editDistance(ref, hyp);
        errors += distance;
        refWords += ref.length;
        if (opts.names.length > 0) {
          const score = nameScore(file.reference, hypothesis, opts.names);
          namesExpected += score.expected;
          namesFound += score.found;
        }
        if (opts.verbose) {
          console.log(`  ${file.name} [${label}] wer=${((distance / Math.max(1, ref.length)) * 100).toFixed(1)}%`);
          console.log(`    ref: ${file.reference}`);
          console.log(`    hyp: ${hypothesis}`);
        }
      }
    }

    const wer = refWords > 0 ? (errors / refWords) * 100 : NaN;
    const nameAccuracy = namesExpected > 0 ? (namesFound / namesExpected) * 100 : null;
    rows.push({ label, wer, nameAccuracy, errors, refWords });
    console.log(`${label}  →  WER ${wer.toFixed(2)}%${
      nameAccuracy === null ? '' : `  names ${nameAccuracy.toFixed(0)}%`
    }`);
  }

  rows.sort((a, b) => a.wer - b.wer);
  console.log('\n── ranked ──');
  for (const r of rows) {
    console.log(
      `  ${r.wer.toFixed(2).padStart(6)}%  ${r.label}` +
      `${r.nameAccuracy === null ? '' : `  (names ${r.nameAccuracy.toFixed(0)}%)`}` +
      `  [${r.errors}/${r.refWords} words]`,
    );
  }
  console.log(
    '\nA gap smaller than roughly 1 WER point on a set this size is noise, not\n' +
    'a result — raise --runs or record more utterances before acting on one.',
  );
}

// Exported so the pure half — WAV reading, levelling, pause detection and the
// scoring — can be exercised without a network or an API key.
export { readWav, applyAgc, pauseOffsets, words, editDistance, nameScore, normalize };

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`bench failed: ${e.message}`);
    process.exit(1);
  });
}
