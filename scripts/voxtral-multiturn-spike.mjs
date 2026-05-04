#!/usr/bin/env node
// Phase 0 spike — validates that the Voxtral WebSocket survives multiple
// audio.append → flush → transcription.done cycles without disconnecting.
//
// Usage:
//   MISTRAL_API_KEY=sk-… node scripts/voxtral-multiturn-spike.mjs
//
// What it does:
//   1. Opens a single WS with sessionMode config (target_streaming_delay_ms).
//   2. Sends three "utterances" back-to-back using short WAV fixtures.
//      Since we don't have real WAV files here, we send 1 s of silence PCM.
//   3. For each utterance: sends audio frames, flushes, and awaits done.
//   4. Logs timing (flush → done latency) and detected language.
//   5. Closes with input_audio.end.
//
// Decision: if the WS closes after the first transcription.done, the
// sessionMode approach is not viable and we fall back to per-turn WS.

import WebSocket from 'ws';

const ENDPOINT = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const MODEL    = 'voxtral-mini-transcribe-realtime-2602';
const SAMPLE_RATE = 16_000;
const TARGET_DELAY = 480; // ms

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error('Set MISTRAL_API_KEY before running this spike.');
  process.exit(1);
}

// Generate 1 s of silence (16-bit signed LE @ 16 kHz).
function silencePcm(durationSeconds = 1) {
  const samples = SAMPLE_RATE * durationSeconds;
  const buf = Buffer.alloc(samples * 2, 0);
  return buf.toString('base64');
}

// Generate synthetic "ah-ah-ah" — three formant-modulated bursts that
// approximate a vowel sequence so the transcriber sees voice-like energy.
// Formants approximate Spanish "a" (700, 1220, 2600 Hz).
function vowelPcmRaw(durationSeconds = 1.2) {
  const samples = Math.floor(SAMPLE_RATE * durationSeconds);
  const buf = Buffer.alloc(samples * 2);
  const fundamental = 130;
  const formants = [700, 1220, 2600];
  const formantGains = [0.45, 0.30, 0.18];
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let f = 0; f < formants.length; f++) {
      s += formantGains[f] * Math.sin(2 * Math.PI * formants[f] * t);
    }
    s *= 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * fundamental * t));
    const phase = (t / durationSeconds) * 3;
    const burstPhase = phase - Math.floor(phase);
    const env = burstPhase < 0.7 ? Math.sin(Math.PI * burstPhase / 0.7) : 0;
    s *= env;
    const val = Math.max(-1, Math.min(1, s)) * 12000;
    buf.writeInt16LE(Math.floor(val), i * 2);
  }
  return buf;
}

function silencePcmRaw(durationSeconds) {
  const samples = Math.floor(SAMPLE_RATE * durationSeconds);
  return Buffer.alloc(samples * 2, 0);
}

// Stream a raw PCM buffer in real-time-ish chunks (CHUNK_MS each), simulating
// the cadence of a real mic. Voxtral's vLLM backend rejects bursts of audio
// faster than wallclock with QueueOverflowError.
async function streamPcm(ws, pcmBuffer, chunkMs = 100) {
  const samplesPerChunk = (SAMPLE_RATE * chunkMs) / 1000;
  const bytesPerChunk = samplesPerChunk * 2;
  for (let off = 0; off < pcmBuffer.length; off += bytesPerChunk) {
    const slice = pcmBuffer.subarray(off, Math.min(off + bytesPerChunk, pcmBuffer.length));
    ws.send(JSON.stringify({ type: 'input_audio.append', audio: slice.toString('base64') }));
    await new Promise((r) => setTimeout(r, chunkMs));
  }
}

async function runSpike() {
  const url = `${ENDPOINT}?model=${encodeURIComponent(MODEL)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

  let sessionReady = false;
  let resolveDone = null;
  let latencyStart = null;

  const results = [];

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('[spike] WS open — sending session.update');
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
          target_streaming_delay_ms: TARGET_DELAY,
        },
      }));
    });

    ws.on('message', (rawData) => {
      let msg;
      try { msg = JSON.parse(rawData.toString()); } catch { return; }

      if (msg.type === 'session.created' || msg.type === 'session.updated') {
        if (!sessionReady) {
          sessionReady = true;
          console.log('[spike] session ready');
          resolve();
        }
        return;
      }

      if (msg.type === 'transcription.text.delta') {
        process.stdout.write(msg.text ?? '');
        return;
      }

      if (msg.type === 'transcription.language') {
        console.log(`\n[spike] language detected: ${msg.language}`);
        return;
      }

      if (msg.type === 'transcription.done') {
        const latency = latencyStart ? Date.now() - latencyStart : null;
        console.log(`\n[spike] transcription.done — text="${msg.text ?? '(empty)'}" latency=${latency ?? '?'} ms`);
        results.push({ text: msg.text ?? '', latency });
        resolveDone?.();
        resolveDone = null;
        latencyStart = null;
        return;
      }

      if (msg.type === 'error') {
        console.error('[spike] server error:', msg.error);
        reject(new Error(JSON.stringify(msg.error)));
      }
    });

    ws.on('error', (e) => {
      console.error('[spike] WS error:', e.message);
      reject(e);
    });

    ws.on('close', (code, reason) => {
      console.log(`[spike] WS closed — code=${code} reason="${reason}"`);
      resolveDone?.(); // unblock any pending flush wait
    });

    // Timeout safety.
    setTimeout(() => reject(new Error('timeout waiting for session.created')), 10_000);
  });

  // ── Three utterances ──────────────────────────────────────────────────────
  for (let i = 1; i <= 3; i++) {
    console.log(`\n[spike] ── utterance ${i} ──`);

    // Stream audio at real-time cadence (silence + vowel bursts + silence).
    const fullPcm = Buffer.concat([
      silencePcmRaw(0.2),
      vowelPcmRaw(1.2),
      silencePcmRaw(0.4),
    ]);
    await streamPcm(ws, fullPcm, 100); // 100 ms chunks, paced at wallclock

    // Flush and wait for done.
    latencyStart = Date.now();
    const doneProm = new Promise((res) => { resolveDone = res; });
    ws.send(JSON.stringify({ type: 'input_audio.flush' }));
    console.log(`[spike] flush sent — awaiting transcription.done`);

    try {
      await Promise.race([
        doneProm,
        new Promise((_, rej) => setTimeout(() => rej(new Error('utterance timeout')), 15_000)),
      ]);
    } catch (e) {
      // Soft-fail: if no done arrived but WS is still open, that's still
      // useful info — log and continue. The decision matrix is whether the
      // WS survives, not whether synthetic audio gets transcribed.
      console.error(`[spike] utterance ${i}: ${e.message} (WS state=${ws.readyState})`);
    }

    // Brief pause between utterances.
    await new Promise((r) => setTimeout(r, 200));

    // If WS is no longer open, the sessionMode approach failed.
    if (ws.readyState !== WebSocket.OPEN) {
      console.error(`[spike] WS closed after utterance ${i} — session mode not viable!`);
      console.error('[spike] Recommendation: use per-turn WS with TLS-cached reconnect.');
      break;
    }
  }

  // ── Close session ─────────────────────────────────────────────────────────
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input_audio.end' }));
    ws.close(1000, 'spike-done');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n[spike] ── summary ──');
  results.forEach((r, i) => {
    console.log(`  utterance ${i + 1}: text="${r.text}" latency=${r.latency ?? '?'} ms`);
  });

  // Critical check: did the WS survive all 3 flush cycles without closing?
  // (Whether transcription.done arrived is secondary — synthetic audio may
  // not yield any text, but the WS staying open is what we're validating.)
  console.log(`\n[spike] WS final state=${ws.readyState} (OPEN=1, CLOSED=3)`);
  console.log(`[spike] transcription.done events received: ${results.length}/3`);

  if (results.length === 3) {
    const avgLatency = results.reduce((s, r) => s + (r.latency ?? 0), 0) / results.length;
    console.log(`[spike] ✓ WS survived all 3 utterances WITH done events. avg latency: ${avgLatency.toFixed(0)} ms`);
    console.log('[spike] Session mode is FULLY viable — proceed with Phase 1.');
  } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    console.log('[spike] ✗ WS closed during the run. Session mode NOT viable — fall back to per-turn.');
  } else {
    console.log(`[spike] ⚠ WS survived 3 flush cycles but ${3 - results.length} did not produce transcription.done.`);
    console.log('[spike] Likely cause: synthetic audio not recognized as speech. Multi-turn protocol is viable.');
    console.log('[spike] Recommended: validate end-to-end with a real WAV recording before shipping.');
  }
}

runSpike().catch((e) => {
  console.error('[spike] fatal:', e.message);
  process.exit(1);
});
