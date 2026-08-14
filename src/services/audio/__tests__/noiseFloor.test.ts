import {
  NoiseFloorTracker,
  rmsToDbfs,
  SILENCE_DBFS,
  DEFAULT_MARGIN_DB,
} from '../noiseFloor';

/** Feed the same level for a stretch of audio, in frames of 32 ms. */
function hold(t: NoiseFloorTracker, levelDb: number, ms: number, speechNearby = false): void {
  for (let i = 0; i < Math.round(ms / 32); i++) t.observe(levelDb, speechNearby);
}

describe('rmsToDbfs', () => {
  it('gives digital silence a finite value', () => {
    // Negative infinity poisons every average it lands in, and the seed below
    // is an average over frames that may well include true zeros.
    expect(rmsToDbfs(0)).toBe(SILENCE_DBFS);
    expect(Number.isFinite(rmsToDbfs(0))).toBe(true);
  });

  it('converts full-scale RMS to dBFS', () => {
    expect(rmsToDbfs(1)).toBeCloseTo(0, 6);
    expect(rmsToDbfs(0.1)).toBeCloseTo(-20, 6);
    expect(rmsToDbfs(0.01)).toBeCloseTo(-40, 6);
  });
});

describe('NoiseFloorTracker — following the room', () => {
  it('drops to a quieter room within a fraction of a second', () => {
    const t = new NoiseFloorTracker();
    t.seed([-30]);

    hold(t, -70, 500);

    // The room went quiet and the estimate went with it, near enough.
    expect(t.floor).toBeLessThan(-65);
  });

  it('takes seconds to accept that a room got louder', () => {
    const t = new NoiseFloorTracker();
    t.seed([-70]);

    // A second of noise 35 dB up is not yet the room — it could just as easily
    // be a person, and one second is not enough to tell the difference.
    hold(t, -35, 1_000);
    expect(t.floor).toBeLessThan(-55);

    // Ten seconds of it is the room.
    hold(t, -35, 9_000);
    expect(t.floor).toBeGreaterThan(-40);
  });

  it('does not let a long utterance walk the floor up under its own voice', () => {
    const t = new NoiseFloorTracker();
    t.seed([-70]);
    const before = t.floor;

    // Twenty seconds of somebody talking, marked as near-field throughout.
    hold(t, -20, 20_000, true);

    // Without the freeze the floor would have climbed towards -20, dragging
    // the gate above the speaker and cutting them off mid-sentence.
    expect(t.floor).toBe(before);
    expect(t.passes(-20)).toBe(true);
  });

  it('still learns from the gaps inside speech', () => {
    const t = new NoiseFloorTracker();
    t.seed([-30]);

    // Falling is never frozen: a pause between words is the clearest look at
    // the room there is, and it is worth having even mid-utterance.
    hold(t, -75, 500, true);

    expect(t.floor).toBeLessThan(-65);
  });
});

describe('NoiseFloorTracker — the gate', () => {
  it('sits a fixed distance above the room', () => {
    const t = new NoiseFloorTracker();
    t.seed([-50]);

    expect(t.gate).toBeCloseTo(-50 + DEFAULT_MARGIN_DB, 6);
    expect(t.passes(-39)).toBe(true);
    expect(t.passes(-41)).toBe(false);
  });

  it('moves with the room rather than with a number chosen in advance', () => {
    const quiet = new NoiseFloorTracker();
    quiet.seed([-70]);
    const loud = new NoiseFloorTracker();
    loud.seed([-40]);

    // The same level is the speaker in one room and the background in the
    // other. That is the whole point — no absolute threshold can be both.
    expect(quiet.passes(-45)).toBe(true);
    expect(loud.passes(-45)).toBe(false);
  });

  it('will not follow a collapsed floor down into hearing everything', () => {
    const t = new NoiseFloorTracker();
    t.seed([-95]); // a muted or dead microphone

    expect(t.gate).toBeGreaterThanOrEqual(-60);
    expect(t.passes(-70)).toBe(false);
  });

  it('stops rising before it climbs past ordinary speech', () => {
    const t = new NoiseFloorTracker();
    hold(t, -20, 60_000); // a genuinely loud room, given as long as it likes

    // Clamped, and deliberately: past this point the honest failure is a gate
    // that admits too much, not one that leaves the app looking like it works
    // while hearing nobody.
    expect(t.gate).toBeLessThanOrEqual(-30);
    expect(t.passes(-25)).toBe(true);
  });
});

describe('NoiseFloorTracker — seeding', () => {
  it('takes the quiet part of the sample, not the average of it', () => {
    // Eleven frames of room tone with a chair scraping through three of them.
    const t = new NoiseFloorTracker();
    t.seed([-62, -60, -61, -59, -60, -62, -61, -20, -18, -22, -60]);

    // The mean of that is about -50. The room is -60.
    expect(t.floor).toBeLessThan(-55);
  });

  it('refuses to install a voice as the room', () => {
    const t = new NoiseFloorTracker();
    t.seed([-18, -16, -20, -17, -19]); // somebody talked through the window

    // Capped — and the fall in the tracker takes it the rest of the way back
    // to the truth within about a second of quiet.
    expect(t.floor).toBeLessThanOrEqual(-35);
    hold(t, -70, 800);
    expect(t.floor).toBeLessThan(-60);
  });

  it('keeps the starting guess when it hears nothing at all', () => {
    const t = new NoiseFloorTracker();
    const before = t.floor;

    t.seed([]);

    // A calibration that could not run must never be the reason the detector
    // goes deaf, so it changes nothing and says nothing.
    expect(t.floor).toBe(before);
    expect(t.seeded).toBe(false);
  });

  it('reports whether it has actually measured a room', () => {
    const t = new NoiseFloorTracker();
    expect(t.seeded).toBe(false);

    t.seed([-60]);
    expect(t.seeded).toBe(true);

    t.reset();
    expect(t.seeded).toBe(false);
  });

  it('forgets the room on reset — the phone may be in another building', () => {
    const t = new NoiseFloorTracker();
    t.seed([-38]);
    const noisy = t.gate;

    t.reset();

    expect(t.gate).toBeLessThan(noisy);
  });
});
