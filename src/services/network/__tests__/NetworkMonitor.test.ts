/**
 * NetworkMonitor unit tests — pure state machine, no native deps, no real network.
 *
 * Run with:  npx jest src/services/network/__tests__/NetworkMonitor
 */

import { NetworkMonitor, type ProbeFn, type NetworkSnapshot } from '../NetworkMonitor';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Probe controlled from the test: queue up results, or set a default. */
function createScriptedProbe(defaultResult = true) {
  const queue: boolean[] = [];
  let calls = 0;
  const probe: ProbeFn = async () => {
    calls++;
    return queue.length > 0 ? queue.shift()! : defaultResult;
  };
  return {
    probe,
    queue: (...results: boolean[]) => { queue.push(...results); },
    get calls() { return calls; },
  };
}

function buildMonitor(probe: ProbeFn, failureThreshold = 2) {
  let nowMs = 1000;
  return new NetworkMonitor({
    probe,
    probeTimeoutMs: 100,
    onlineIntervalMs: 10_000,
    offlineIntervalMs: 5_000,
    failureThreshold,
    now: () => ++nowMs,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('NetworkMonitor', () => {
  it('starts in unknown state', () => {
    const { probe } = createScriptedProbe();
    const m = buildMonitor(probe);
    expect(m.getSnapshot().state).toBe('unknown');
  });

  it('transitions unknown → online on first successful probe', async () => {
    const scripted = createScriptedProbe(true);
    const m = buildMonitor(scripted.probe);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('online');
    expect(m.getSnapshot().lastProbeOk).toBe(true);
    expect(scripted.calls).toBe(1);
  });

  it('transitions unknown → offline on first failed probe (no debounce from unknown)', async () => {
    const scripted = createScriptedProbe(false);
    const m = buildMonitor(scripted.probe);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('offline');
    expect(m.getSnapshot().consecutiveFailures).toBe(1);
  });

  it('requires failureThreshold consecutive failures to flip online → offline', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe, 2);

    scripted.queue(true);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('online');

    // First failure — still online (under threshold)
    scripted.queue(false);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('online');
    expect(m.getSnapshot().consecutiveFailures).toBe(1);

    // Second failure — flip to offline
    scripted.queue(false);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('offline');
    expect(m.getSnapshot().consecutiveFailures).toBe(2);
  });

  it('resets failure counter on recovery', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe, 3);

    scripted.queue(true, false, false);
    await m.probeNow();
    await m.probeNow();
    await m.probeNow();
    expect(m.getSnapshot().consecutiveFailures).toBe(2);
    expect(m.getSnapshot().state).toBe('online'); // under threshold of 3

    scripted.queue(true);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('online');
    expect(m.getSnapshot().consecutiveFailures).toBe(0);
  });

  it('does not require threshold when recovering offline → online (single success suffices)', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe, 2);

    scripted.queue(false, false); // into offline
    await m.probeNow();
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('offline');

    scripted.queue(true);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('online');
  });

  it('notifies subscribers only on state change, not every probe', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe, 2);
    const seen: NetworkSnapshot[] = [];
    m.subscribe(s => { seen.push(s); });

    // unknown → online (1 notify)
    scripted.queue(true);
    await m.probeNow();
    // online → online (0 notify — successful re-probe, no transition)
    scripted.queue(true);
    await m.probeNow();
    // online, 1 failure, still online (0 notify)
    scripted.queue(false);
    await m.probeNow();
    // online → offline (1 notify)
    scripted.queue(false);
    await m.probeNow();

    expect(seen.map(s => s.state)).toEqual(['online', 'offline']);
  });

  it('unsubscribe stops further notifications', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe);
    const seen: NetworkSnapshot[] = [];
    const off = m.subscribe(s => { seen.push(s); });

    scripted.queue(true);
    await m.probeNow();
    expect(seen).toHaveLength(1);

    off();
    scripted.queue(false, false);
    await m.probeNow();
    await m.probeNow();
    expect(seen).toHaveLength(1); // unchanged
  });

  it('subscriber throwing does not break the monitor', async () => {
    const scripted = createScriptedProbe();
    const m = buildMonitor(scripted.probe);
    m.subscribe(() => { throw new Error('bad subscriber'); });
    const goodSeen: NetworkSnapshot[] = [];
    m.subscribe(s => { goodSeen.push(s); });

    scripted.queue(true);
    await m.probeNow();
    expect(goodSeen).toHaveLength(1);
  });

  it('treats a thrown probe as a failure', async () => {
    const probe: ProbeFn = async () => { throw new Error('boom'); };
    const m = buildMonitor(probe);
    await m.probeNow();
    expect(m.getSnapshot().state).toBe('offline');
  });

  it('start() schedules periodic probes; stop() cancels them', async () => {
    jest.useFakeTimers();
    try {
      const scripted = createScriptedProbe(true);
      const m = buildMonitor(scripted.probe);
      m.start();

      // Drain the immediate first probe
      await Promise.resolve();
      await Promise.resolve();
      expect(scripted.calls).toBeGreaterThanOrEqual(1);
      expect(m.getSnapshot().state).toBe('online');

      // Advance past the online interval — should trigger another probe
      const callsBefore = scripted.calls;
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(scripted.calls).toBeGreaterThan(callsBefore);

      m.stop();
      const callsAtStop = scripted.calls;
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(scripted.calls).toBe(callsAtStop);
    } finally {
      jest.useRealTimers();
    }
  });

  it('discards results from probes issued before stop()', async () => {
    // Hanging probe that never resolves until we tell it to
    let resolveProbe: (ok: boolean) => void = () => {};
    const probe: ProbeFn = () => new Promise(r => { resolveProbe = r; });
    const m = buildMonitor(probe);

    const pending = m.probeNow();
    m.stop();
    resolveProbe(true);
    await pending;

    // Snapshot should remain unknown — the late result was discarded
    expect(m.getSnapshot().state).toBe('unknown');
  });
});
