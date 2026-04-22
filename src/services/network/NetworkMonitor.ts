// NetworkMonitor — tracks whether we can reach the online STT backend.
//
// v1 design: pure JS, probe-based. A small HTTP HEAD/GET is issued on an
// interval (and on demand via probeNow()); observed results drive a 3-state
// machine: unknown → online / offline. Transitions are debounced so a single
// flaky packet doesn't flip us offline.
//
// Why not NetInfo? We'll add it later as a battery optimization (event-driven
// OS signal replaces polling when cellular/wifi drops). It still doesn't tell
// us the API is reachable, so a probe is always required on top. Starting
// probe-only keeps the first PR self-contained and testable without a native
// rebuild.

export type NetworkState = 'unknown' | 'online' | 'offline';

export interface NetworkSnapshot {
  readonly state: NetworkState;
  readonly lastProbeOk: boolean;
  readonly lastChangedAt: number;
  readonly consecutiveFailures: number;
}

/** Probe returns true if the endpoint is reachable within timeoutMs. */
export type ProbeFn = (timeoutMs: number) => Promise<boolean>;

export interface NetworkMonitorOptions {
  readonly probe: ProbeFn;
  /** Timeout applied to each probe request. */
  readonly probeTimeoutMs: number;
  /** Probe cadence when state is 'online' — less frequent (battery). */
  readonly onlineIntervalMs: number;
  /** Probe cadence when state is 'offline' or 'unknown' — more frequent (fast recovery). */
  readonly offlineIntervalMs: number;
  /**
   * Consecutive probe failures required to transition online → offline.
   * Protects against single-packet blips. Default 2.
   */
  readonly failureThreshold: number;
  /** Optional clock — injected for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export type NetworkSubscriber = (snapshot: NetworkSnapshot) => void;

const DEFAULT_OPTIONS: Omit<NetworkMonitorOptions, 'probe'> = {
  probeTimeoutMs: 3_000,
  onlineIntervalMs: 30_000,
  offlineIntervalMs: 10_000,
  failureThreshold: 2,
};

export class NetworkMonitor {
  private readonly opts: NetworkMonitorOptions;
  private snapshot: NetworkSnapshot;
  private subscribers = new Set<NetworkSubscriber>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Monotonic generation — lets in-flight probes notice that stop()/reset happened. */
  private generation = 0;

  constructor(options: Partial<NetworkMonitorOptions> & Pick<NetworkMonitorOptions, 'probe'>) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.snapshot = {
      state: 'unknown',
      lastProbeOk: false,
      lastChangedAt: this.clock(),
      consecutiveFailures: 0,
    };
  }

  getSnapshot(): NetworkSnapshot {
    return this.snapshot;
  }

  subscribe(cb: NetworkSubscriber): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  /** Begin periodic probing. Safe to call multiple times. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Kick off an immediate probe, then schedule periodic ones.
    void this.probeAndSchedule();
  }

  /** Stop probing and clear any pending timer. */
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force an immediate probe, bypassing the scheduled cadence.
   * Returns the resulting state. Useful before the first online request.
   */
  async probeNow(): Promise<NetworkState> {
    await this.runProbe();
    return this.snapshot.state;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async probeAndSchedule(): Promise<void> {
    const gen = this.generation;
    await this.runProbe();
    if (!this.running || gen !== this.generation) return;
    const delay = this.snapshot.state === 'online'
      ? this.opts.onlineIntervalMs
      : this.opts.offlineIntervalMs;
    this.timer = setTimeout(() => { void this.probeAndSchedule(); }, delay);
  }

  private async runProbe(): Promise<void> {
    const gen = this.generation;
    let ok = false;
    try {
      ok = await this.opts.probe(this.opts.probeTimeoutMs);
    } catch {
      ok = false;
    }
    // Discard stale results
    if (gen !== this.generation) return;
    this.applyProbeResult(ok);
  }

  private applyProbeResult(ok: boolean): void {
    const prev = this.snapshot;
    let next: NetworkSnapshot;

    if (ok) {
      // Success always resets the failure counter and transitions to online.
      const becameOnline = prev.state !== 'online';
      next = {
        state: 'online',
        lastProbeOk: true,
        lastChangedAt: becameOnline ? this.clock() : prev.lastChangedAt,
        consecutiveFailures: 0,
      };
    } else {
      const failures = prev.consecutiveFailures + 1;
      // From 'online' we require failureThreshold consecutive failures before flipping.
      // From 'unknown' a single failure is enough to commit to 'offline'.
      const shouldFlip = prev.state === 'online'
        ? failures >= this.opts.failureThreshold
        : true;
      const newState: NetworkState = shouldFlip ? 'offline' : prev.state;
      next = {
        state: newState,
        lastProbeOk: false,
        lastChangedAt: newState !== prev.state ? this.clock() : prev.lastChangedAt,
        consecutiveFailures: failures,
      };
    }

    this.snapshot = next;
    if (next.state !== prev.state) {
      this.notify();
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try { cb(this.snapshot); } catch { /* subscriber errors must not break the monitor */ }
    }
  }
}

// ── Default probe: HTTP HEAD against Cloudflare's trace endpoint ────────────

/**
 * Default probe — small HTTPS request with AbortController timeout.
 * Cloudflare's /cdn-cgi/trace endpoint is globally available, returns ~200 bytes,
 * and has essentially 100% uptime — a good "do I have internet at all" signal.
 *
 * Once the Voxtral backend is known, swap this for a dedicated health check
 * URL so the probe reflects API reachability, not just internet connectivity.
 */
export function createDefaultProbe(url = 'https://1.1.1.1/cdn-cgi/trace'): ProbeFn {
  return async (timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
