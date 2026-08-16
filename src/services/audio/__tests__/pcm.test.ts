import { decodePcm16, encodePcm16 } from '../pcm';
import { SpeechAgc } from '../SpeechAgc';
import { frameRms } from '../audioLevelBus';

/** A chunk of speech-like audio at a given RMS level, as full-scale fraction. */
function tone(samples: number, rmsFraction: number): Int16Array {
  const pcm = new Int16Array(samples);
  // A sine's RMS is amplitude/√2, so scale the amplitude to land on target.
  const amplitude = rmsFraction * Math.SQRT2 * 32768;
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000));
  }
  return pcm;
}

const dbfs = (pcm: Int16Array): number => 20 * Math.log10(frameRms(pcm));

describe('pcm codec', () => {
  it('round-trips samples exactly', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    const decoded = decodePcm16(encodePcm16(pcm));
    expect(Array.from(decoded)).toEqual(Array.from(pcm));
  });

  it('agrees with the platform decoder', () => {
    const pcm = tone(512, 0.1);
    const base64 = encodePcm16(pcm);
    // What the VAD path used before this file existed.
    const binary = Buffer.from(base64, 'base64');
    expect(Array.from(decodePcm16(base64))).toEqual(
      Array.from(new Int16Array(binary.buffer, binary.byteOffset, binary.length / 2)),
    );
  });

  it('survives a truncated chunk instead of throwing', () => {
    const base64 = encodePcm16(tone(64, 0.1));
    expect(() => decodePcm16(base64.slice(0, 13))).not.toThrow();
    expect(decodePcm16('').length).toBe(0);
    expect(decodePcm16('!!!!').length).toBe(0);
  });
});

describe('SpeechAgc', () => {
  const CHUNK = 2048; // 128 ms at 16 kHz, the capture library's chunk size

  it('lifts a quiet talker to the target and stops there', () => {
    const agc = new SpeechAgc();
    let last: Int16Array<ArrayBufferLike> = new Int16Array(0);
    // ≈ -32 dBFS: an ordinary voice across a table with no gain control.
    for (let i = 0; i < 60; i++) last = agc.process(tone(CHUNK, 0.025));
    expect(dbfs(last)).toBeGreaterThan(-23);
    expect(dbfs(last)).toBeLessThan(-19);
  });

  it('refuses to amplify a distant talker without limit', () => {
    const agc = new SpeechAgc();
    let last: Int16Array<ArrayBufferLike> = new Int16Array(0);
    // ≈ -45 dBFS wants +24 dB. It gets 15, and the rest is the room's problem:
    // past that point this is amplifying the distance, not the speaker.
    for (let i = 0; i < 60; i++) last = agc.process(tone(CHUNK, 0.0056));
    expect(agc.currentGainDb).toBeCloseTo(15, 0);
    expect(dbfs(last)).toBeCloseTo(-30, 0);
  });

  it('leaves an already well-levelled talker alone, allocating nothing', () => {
    const agc = new SpeechAgc();
    const pcm = tone(CHUNK, 0.089); // ≈ -21 dBFS, the target
    let out = agc.process(pcm);
    for (let i = 0; i < 20; i++) out = agc.process(pcm);
    expect(out).toBe(pcm);
  });

  it('never clips, even when the target would overshoot', () => {
    const agc = new SpeechAgc();
    // Quiet enough to earn maximum boost, then a shout on the same gain.
    for (let i = 0; i < 60; i++) agc.process(tone(CHUNK, 0.004));
    const loud = agc.process(tone(CHUNK, 0.6));
    let peak = 0;
    for (const s of loud) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThanOrEqual(32000);
  });

  it('does not chase silence', () => {
    const agc = new SpeechAgc();
    for (let i = 0; i < 100; i++) agc.process(tone(CHUNK, 0.0003)); // ≈ -70 dBFS
    expect(agc.currentGainDb).toBe(0);
  });

  it('moves slowly enough that one syllable cannot swing it', () => {
    const agc = new SpeechAgc();
    agc.process(tone(CHUNK, 0.0056)); // one quiet chunk, wanting the full +15
    expect(agc.currentGainDb).toBeLessThan(3);
  });

  it('reports what the microphone actually delivered', () => {
    const agc = new SpeechAgc();
    agc.process(tone(CHUNK, 0.01)); // -40 dBFS
    expect(agc.inputDbfs).toBeCloseTo(-40, 0);
  });

  it('forgets its gain between conversations', () => {
    const agc = new SpeechAgc();
    for (let i = 0; i < 60; i++) agc.process(tone(CHUNK, 0.0056));
    expect(agc.currentGainDb).toBeGreaterThan(5);
    agc.reset();
    expect(agc.currentGainDb).toBe(0);
    expect(agc.inputDbfs).toBe(-Infinity);
  });
});
