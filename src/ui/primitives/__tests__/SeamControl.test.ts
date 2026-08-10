import { BAR_COUNT, WAVE_SHAPE, waveAmplitude, type WaveShape } from '../SeamControl';

const PHASES = Array.from({ length: 48 }, (_, i) => i / 48);
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => i);

function amp(index: number, phase: number, level: number, s: WaveShape): number {
  return waveAmplitude(index, phase, level, s.floor, s.swing, s.reactivity, s.spread);
}

/** Highest amplitude bar `index` reaches over one full cycle. */
function peak(index: number, level: number, s: WaveShape): number {
  return Math.max(...PHASES.map(p => amp(index, p, level, s)));
}

/** Phase (0..1) at which bar `index` peaks. */
function peakPhase(index: number, level: number, s: WaveShape): number {
  let best = 0;
  let bestValue = -Infinity;
  for (const p of PHASES) {
    const v = amp(index, p, level, s);
    if (v > bestValue) {
      bestValue = v;
      best = p;
    }
  }
  return best;
}

describe.each(Object.entries(WAVE_SHAPE))('waveAmplitude — %s', (_name, shape) => {
  it('never inverts a bar or overflows its box', () => {
    for (const level of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      for (const index of BARS) {
        for (const phase of PHASES) {
          const a = amp(index, phase, level, shape);
          expect(Number.isFinite(a)).toBe(true);
          expect(a).toBeGreaterThan(0);
          expect(a).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ripples outward — the centre bar and the edge bar peak at different times', () => {
    const centre = peakPhase((BAR_COUNT - 1) / 2, 1, shape);
    const edge = peakPhase(0, 1, shape);
    const gap = Math.abs(centre - edge);
    const circular = Math.min(gap, 1 - gap);
    expect(circular).toBeGreaterThan(0.15);
  });
});

describe('waveAmplitude — listening', () => {
  const shape = WAVE_SHAPE.escuchando;

  it('rests low in a silent room, so "armed" never looks like "hearing you"', () => {
    for (const index of BARS) {
      for (const phase of PHASES) {
        expect(amp(index, phase, 0, shape)).toBeLessThanOrEqual(shape.floor + shape.swing);
      }
    }
  });

  it('grows monotonically with the level', () => {
    for (const index of BARS) {
      for (const phase of [0, 0.2, 0.45, 0.7, 0.9]) {
        let previous = -1;
        for (const level of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
          const a = amp(index, phase, level, shape);
          expect(a).toBeGreaterThan(previous);
          previous = a;
        }
      }
    }
  });

  it('reaches full scale at the centre and arches down toward the edges', () => {
    const peaks = BARS.map(i => peak(i, 1, shape));
    const centre = (BAR_COUNT - 1) / 2;
    expect(peaks[centre]).toBeGreaterThan(0.98);
    expect(peaks[0]).toBeLessThan(peaks[centre]);
    expect(peaks[BAR_COUNT - 1]).toBeLessThan(peaks[centre]);
    // The arch is symmetric enough to read as one shape, detune aside.
    expect(Math.abs(peaks[0] - peaks[BAR_COUNT - 1])).toBeLessThan(0.05);
  });
});

describe('waveAmplitude — speaking', () => {
  const shape = WAVE_SHAPE.traduciendo;

  it('ignores the microphone entirely — the phone must not visualise itself', () => {
    for (const index of BARS) {
      for (const phase of PHASES) {
        expect(amp(index, phase, 1, shape)).toBe(amp(index, phase, 0, shape));
      }
    }
  });

  it('still swells, so the control never looks frozen while the phone talks', () => {
    const values = PHASES.map(p => amp(3, p, 0, shape));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3);
  });
});
