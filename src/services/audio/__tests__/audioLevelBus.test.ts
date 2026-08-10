import {
  LEVEL_CEIL_DBFS,
  LEVEL_FLOOR_DBFS,
  frameRms,
  getAudioLevel,
  publishAudioFrame,
  resetAudioLevel,
  rmsToLevel,
  subscribeAudioLevel,
} from '../audioLevelBus';

/** RMS of a full-scale sine at the given dBFS. */
function rmsAt(dbfs: number): number {
  return Math.pow(10, dbfs / 20);
}

beforeEach(() => {
  resetAudioLevel();
});

describe('frameRms', () => {
  it('is zero for silence and for an empty frame', () => {
    expect(frameRms(new Int16Array(512))).toBe(0);
    expect(frameRms(new Int16Array(0))).toBe(0);
  });

  it('is 1 for a full-scale square wave', () => {
    const pcm = new Int16Array(512);
    pcm.fill(-32768);
    expect(frameRms(pcm)).toBeCloseTo(1, 5);
  });

  it('tracks amplitude', () => {
    const quiet = new Int16Array(512).fill(1000);
    const loud = new Int16Array(512).fill(20000);
    expect(frameRms(quiet)).toBeLessThan(frameRms(loud));
  });
});

describe('rmsToLevel', () => {
  it('floors silence and anything below the window', () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(-1)).toBe(0);
    expect(rmsToLevel(rmsAt(LEVEL_FLOOR_DBFS - 10))).toBe(0);
  });

  it('clips at the top of the window', () => {
    expect(rmsToLevel(rmsAt(LEVEL_CEIL_DBFS))).toBe(1);
    expect(rmsToLevel(1)).toBe(1);
  });

  it('is logarithmic — the midpoint of the dB window sits at ~0.5', () => {
    const midDbfs = (LEVEL_FLOOR_DBFS + LEVEL_CEIL_DBFS) / 2;
    expect(rmsToLevel(rmsAt(midDbfs))).toBeCloseTo(0.5, 5);
  });

  it('is monotonic across the window', () => {
    let previous = -1;
    for (let dbfs = LEVEL_FLOOR_DBFS; dbfs <= LEVEL_CEIL_DBFS; dbfs += 2) {
      const level = rmsToLevel(rmsAt(dbfs));
      expect(level).toBeGreaterThan(previous);
      previous = level;
    }
  });
});

describe('envelope', () => {
  const loud = rmsAt(LEVEL_CEIL_DBFS);

  it('rises on speech and never overshoots full scale', () => {
    publishAudioFrame(loud);
    const afterOne = getAudioLevel();
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(1);

    for (let i = 0; i < 50; i++) publishAudioFrame(loud);
    expect(getAudioLevel()).toBeGreaterThan(0.95);
    expect(getAudioLevel()).toBeLessThanOrEqual(1);
  });

  it('releases more slowly than it attacks', () => {
    publishAudioFrame(loud);
    const attackStep = getAudioLevel();

    for (let i = 0; i < 50; i++) publishAudioFrame(loud);
    const peak = getAudioLevel();
    publishAudioFrame(0);
    const releaseStep = peak - getAudioLevel();

    expect(releaseStep).toBeLessThan(attackStep);
  });

  it('settles to a true zero after silence, so the wave fully rests', () => {
    for (let i = 0; i < 50; i++) publishAudioFrame(loud);
    for (let i = 0; i < 400; i++) publishAudioFrame(0);
    expect(getAudioLevel()).toBe(0);
  });

  it('resetAudioLevel snaps to silence mid-utterance', () => {
    for (let i = 0; i < 50; i++) publishAudioFrame(loud);
    expect(getAudioLevel()).toBeGreaterThan(0.5);
    resetAudioLevel();
    expect(getAudioLevel()).toBe(0);
  });
});

describe('subscribers', () => {
  const loud = rmsAt(LEVEL_CEIL_DBFS);

  it('receives the current level on subscribe, then every update', () => {
    publishAudioFrame(loud);
    const seen: number[] = [];
    const unsubscribe = subscribeAudioLevel(v => seen.push(v));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(getAudioLevel());

    publishAudioFrame(loud);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);

    unsubscribe();
    publishAudioFrame(loud);
    expect(seen).toHaveLength(2);
  });

  it('does not notify on a redundant reset', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAudioLevel(v => seen.push(v));
    seen.length = 0;

    resetAudioLevel(); // already silent
    expect(seen).toHaveLength(0);

    unsubscribe();
  });

  it('keeps delivering when one subscriber throws', () => {
    const seen: number[] = [];
    const unsubBad = subscribeAudioLevel(() => {
      throw new Error('meter exploded');
    });
    const unsubGood = subscribeAudioLevel(v => seen.push(v));
    seen.length = 0;

    expect(() => publishAudioFrame(loud)).not.toThrow();
    expect(seen).toHaveLength(1);

    unsubBad();
    unsubGood();
  });
});
