// noiseFloor — how loud the room is when nobody at this table is talking.
//
// The problem this exists for: in a quiet room every threshold works, and in a
// café none of them do. A fixed "this is speech" level is calibrated for one
// room and wrong in every other — set it for the café and a soft speaker in a
// living room goes unheard; set it for the living room and the café's own
// clatter takes every turn. Parly ships one number to every room there is, so
// that number cannot be a level. It has to be a distance.
//
// So nothing here is absolute. The tracker follows the *lower envelope* of the
// signal — the level the room falls back to between events — and every decision
// is expressed as dB above it. Carry the same phone from a library to a bar and
// the estimate moves with it.
//
// The asymmetry is the mechanism, and it runs the opposite way round to the
// envelope follower in audioLevelBus. Falling fast and rising slowly is what
// makes this track the floor instead of the signal: a level *below* the current
// estimate is direct evidence about the room and is believed almost at once,
// while a level *above* it might be the room getting louder or might be someone
// talking, and one frame is never going to say which — so it drifts up over
// seconds. Speech, being loud and brief, barely moves it. A television, being
// loud and continuous, is slowly absorbed into it, which is the right answer:
// after a few seconds a TV *is* the room.
//
// What this does NOT do is decide what is speech. It has no opinion on the
// difference between a voice and a blender; it only says how far above the
// room's own level a frame sits. Pairing that with something that knows speech
// from noise is the caller's job — see SileroVadService.

import { FRAME_MS } from './audioLevelBus';

/** Floor for the dBFS conversion. Digital silence is negative infinity, which
 *  poisons every average it touches; -100 dBFS is far below anything a
 *  microphone produces and behaves like a number. */
export const SILENCE_DBFS = -100;

/** Full-scale RMS → dBFS, with digital silence given a finite value. */
export function rmsToDbfs(rms: number): number {
  if (!(rms > 0)) return SILENCE_DBFS;
  const db = 20 * Math.log10(rms);
  return db < SILENCE_DBFS ? SILENCE_DBFS : db;
}

export interface NoiseFloorConfig {
  /** How far above the floor a frame must sit to be the person at this table
   *  rather than the room behind them (dB). */
  readonly marginDb?: number;
  /** Time constant for the estimate falling towards a quieter room (ms). */
  readonly fallMs?: number;
  /** Time constant for the estimate rising towards a louder one (ms). */
  readonly riseMs?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * How far above the room a frame has to be to count as near-field.
 *
 * Two speakers share one phone lying flat between them — call it 40 cm each.
 * Anything Parly is meant to ignore is across the table or across the room, and
 * the inverse-square law alone puts 2 m at ~14 dB down on 40 cm. 10 dB keeps a
 * margin under that for a speaker who leans back, or a television that is
 * genuinely loud.
 *
 * Raising this rejects more of the room and starts costing quiet speakers;
 * lowering it does the reverse. It is the single most consequential number in
 * noisy-room behaviour, so it is a constant with a name rather than a literal.
 */
export const DEFAULT_MARGIN_DB = 10;

/** A drop is evidence and is taken almost immediately — but not in one frame,
 *  or a single gap between syllables would reset the floor to silence. */
const DEFAULT_FALL_MS = 150;
/** A rise might be the room or might be a person, and the estimate waits to
 *  find out. Long enough that no single utterance can lift the floor out from
 *  under itself; short enough that a room that genuinely gets louder — a café
 *  filling up, a TV switched on — is absorbed within a few seconds. */
const DEFAULT_RISE_MS = 4_000;

/**
 * Where the estimate starts, before any room has been heard.
 *
 * Deliberately low: the gate derived from it is permissive, so a calibration
 * that never runs (no frames, mic still opening) leaves hands-free listening
 * as it did before this existed rather than deaf. Matches the silence measured
 * on device — see LEVEL_FLOOR_DBFS in audioLevelBus.
 */
const INITIAL_FLOOR_DBFS = -70;

/**
 * Guard rails on the derived gate.
 *
 * The floor is an estimate, and an estimate can be wrong in both directions.
 * Too low — a muted or dead mic reading -95 dBFS — and the gate sits below
 * anything and admits everything. Too high — a genuinely loud bar — and it
 * climbs past ordinary speech and Parly goes deaf while looking like it is
 * working, which is the worse of the two failures by a distance. So the gate is
 * clamped at both ends: the ceiling is a decision to degrade to no gate at all
 * rather than to stop hearing the person who is actually talking.
 *
 * The window is drawn around the levels measured on device: silence near
 * -70 dBFS, ordinary speech frames -35..-20, peaks around -13.
 */
const GATE_MIN_DBFS = -60;
const GATE_MAX_DBFS = -30;

/**
 * Which of the calibration frames to believe.
 *
 * The window is short and nobody is asked to be quiet during it, so it can
 * catch a word, a chair, a door. Taking the mean would let any of those set the
 * floor for the whole conversation; taking the minimum would pin it to whatever
 * single frame happened to be quietest. The lower quartile is the room with the
 * events trimmed off it.
 */
const SEED_PERCENTILE = 0.25;

/** Highest level a calibration is allowed to install as the floor. Someone who
 *  talks straight through the window would otherwise seed their own voice as
 *  the room and gate themselves out; the fast fall recovers from that within a
 *  second of quiet, and this bounds how far it has to fall. */
const SEED_MAX_DBFS = -35;

// ── Tracker ──────────────────────────────────────────────────────────────────

export class NoiseFloorTracker {
  private floorDb = INITIAL_FLOOR_DBFS;
  private calibrated = false;

  private readonly marginDb: number;
  private readonly fallCoef: number;
  private readonly riseCoef: number;

  constructor(config: NoiseFloorConfig = {}) {
    this.marginDb = config.marginDb ?? DEFAULT_MARGIN_DB;
    // One-pole coefficients over a fixed 32 ms step — the frame's audio
    // duration, not wall-clock, so a burst of frames arriving in one chunk
    // advances the estimate by the audio it represents.
    this.fallCoef = 1 - Math.exp(-FRAME_MS / (config.fallMs ?? DEFAULT_FALL_MS));
    this.riseCoef = 1 - Math.exp(-FRAME_MS / (config.riseMs ?? DEFAULT_RISE_MS));
  }

  /** The room's own level, in dBFS. */
  get floor(): number {
    return this.floorDb;
  }

  /** The level a frame must clear to be the person at this table. */
  get gate(): number {
    const raw = this.floorDb + this.marginDb;
    return raw < GATE_MIN_DBFS ? GATE_MIN_DBFS : raw > GATE_MAX_DBFS ? GATE_MAX_DBFS : raw;
  }

  /** Whether a room-tone sample has been installed, as opposed to the estimate
   *  having only ever adapted from its starting guess. */
  get seeded(): boolean {
    return this.calibrated;
  }

  /** How far this frame sits above the room. Negative means below it. */
  snr(levelDb: number): number {
    return levelDb - this.floorDb;
  }

  /** Whether this frame is loud enough, relative to the room, to be someone at
   *  this table rather than someone across it. */
  passes(levelDb: number): boolean {
    return levelDb >= this.gate;
  }

  /**
   * Fold one frame's level into the estimate.
   *
   * `speechNearby` freezes the upward drift. Without it a long utterance walks
   * the floor up under its own voice, the gate follows, and the speaker gates
   * themselves out somewhere in the middle of their own sentence. Downward
   * movement is never frozen: a gap inside speech is still the room, and it is
   * the most reliable look at the room we ever get.
   */
  observe(levelDb: number, speechNearby: boolean): void {
    if (levelDb < this.floorDb) {
      this.floorDb += (levelDb - this.floorDb) * this.fallCoef;
    } else if (!speechNearby) {
      this.floorDb += (levelDb - this.floorDb) * this.riseCoef;
    }
  }

  /**
   * Install a room-tone sample as the floor, skipping the seconds the tracker
   * would otherwise need to adapt from its starting guess.
   *
   * This is the whole of "calibration": the tracker above is what actually
   * keeps up with the room, and it works with or without this. What seeding
   * buys is that the *first* utterance of a conversation is judged against the
   * room it was spoken in, rather than being the one that pays for the
   * adaptation.
   *
   * Returns the floor it installed, for logging.
   */
  seed(levelsDb: readonly number[]): number {
    if (levelsDb.length === 0) return this.floorDb;
    const sorted = [...levelsDb].sort((a, b) => a - b);
    const at = Math.floor((sorted.length - 1) * SEED_PERCENTILE);
    const sample = sorted[at];
    this.floorDb = sample > SEED_MAX_DBFS ? SEED_MAX_DBFS : sample;
    this.calibrated = true;
    return this.floorDb;
  }

  /** Forget the room. The next session starts from the same guess as the first
   *  one did — a room heard ten minutes ago is not evidence about this one. */
  reset(): void {
    this.floorDb = INITIAL_FLOOR_DBFS;
    this.calibrated = false;
  }
}
