// In-app crash-resilient log store.
//
// Why this exists:
//   - Release-signed APKs don't show the React Native red box.
//   - This user can't run adb/logcat from a non-dev environment.
//   - Native or JS crashes therefore present as a silent app close, with
//     no diagnostic surface.
//
// Strategy:
//   - Keep a bounded in-memory ring buffer (subscribers see live updates).
//   - Persist every write to a single JSON file on disk via react-native-fs.
//     Writes are serialized through a Promise chain so concurrent log calls
//     don't corrupt the file. Each write is fire-and-forget from the caller's
//     perspective; the JS thread never blocks.
//   - On app start we load the previous session's file, then append a clear
//     "session start" marker. If the previous session crashed, its trail is
//     visible on the next launch — that's the entire point.
//   - We hijack `console.log/warn/error` and `ErrorUtils.setGlobalHandler`
//     so any code (theirs, ours, third-party) ends up in the buffer
//     automatically.
//
// Caveat: a hard native crash (SIGSEGV) may take the process down before the
// last few queued writes flush to disk. We compensate by logging *before*
// risky operations, so the most recent entry tells you what was about to
// happen.

import * as RNFS from '@dr.pogodin/react-native-fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly id: string;
  readonly timestamp: number;       // epoch ms
  readonly relativeMs: number;      // ms since session start (this run)
  readonly level: LogLevel;
  readonly message: string;
  readonly stack?: string;
}

const LOG_PATH = `${RNFS.DocumentDirectoryPath}/parly-logs.json`;
const MAX_ENTRIES = 600;

/** Coalesce disk writes to at most one per window. Without this, high-frequency
 *  logging (VAD telemetry, per-chunk events) stringifies and rewrites the whole
 *  600-entry buffer on EVERY entry — saturating the bridge and disk during the
 *  exact moments conversation latency matters most. Errors bypass the throttle
 *  so a crash trail still survives. */
const FLUSH_THROTTLE_MS = 1_000;

let buffer: LogEntry[] = [];
const listeners = new Set<(entries: readonly LogEntry[]) => void>();
let writeChain: Promise<unknown> = Promise.resolve();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushPending = false;
let initialized = false;
let sessionStart = Date.now();

function notify(): void {
  for (const fn of listeners) fn(buffer);
}

/** Serialize the current buffer to disk behind any prior write. */
function writeBufferToDisk(): void {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      try {
        await RNFS.writeFile(LOG_PATH, JSON.stringify(buffer), 'utf8');
      } catch {
        // Ignore — disk may be full, permissions may be wrong, etc.
      }
    });
}

function scheduleFlush(immediate = false): void {
  if (immediate) {
    flushPending = false;
    writeBufferToDisk();
    return;
  }
  if (flushTimer) {
    // Inside the throttle window — coalesce; the trailing write picks this up.
    flushPending = true;
    return;
  }
  // Leading edge: persist immediately, then hold a window during which further
  // entries collapse into a single trailing write.
  writeBufferToDisk();
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (flushPending) {
      flushPending = false;
      writeBufferToDisk();
    }
  }, FLUSH_THROTTLE_MS);
}

function pushEntry(level: LogLevel, message: string, stack?: string): void {
  const now = Date.now();
  const entry: LogEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    relativeMs: now - sessionStart,
    level,
    message,
    stack,
  };
  buffer = buffer.length >= MAX_ENTRIES
    ? [...buffer.slice(buffer.length - MAX_ENTRIES + 1), entry]
    : [...buffer, entry];
  notify();
  // Errors flush now (crash resilience); everything else is throttled.
  scheduleFlush(level === 'error');
}

function formatRest(rest: readonly unknown[]): string {
  if (rest.length === 0) return '';
  const parts = rest.map(r => {
    if (r === undefined) return 'undefined';
    if (r === null) return 'null';
    if (r instanceof Error) return `${r.name}: ${r.message}`;
    if (typeof r === 'object') {
      try {
        return JSON.stringify(r);
      } catch {
        return Object.prototype.toString.call(r);
      }
    }
    return String(r);
  });
  return ' ' + parts.join(' ');
}

export const log = {
  debug: (msg: string, ...rest: unknown[]) => pushEntry('debug', msg + formatRest(rest)),
  info:  (msg: string, ...rest: unknown[]) => pushEntry('info',  msg + formatRest(rest)),
  warn:  (msg: string, ...rest: unknown[]) => pushEntry('warn',  msg + formatRest(rest)),
  error: (msg: string, ...rest: unknown[]) => {
    const err = rest.find(r => r instanceof Error) as Error | undefined;
    pushEntry('error', msg + formatRest(rest), err?.stack);
  },
};

export function subscribeLogs(fn: (entries: readonly LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(buffer);
  return () => {
    listeners.delete(fn);
  };
}

export function getLogs(): readonly LogEntry[] {
  return buffer;
}

export function clearLogs(): void {
  buffer = [];
  notify();
  scheduleFlush(true);
}

export function exportLogsAsText(): string {
  if (buffer.length === 0) return '(no logs)';
  return buffer
    .map(e => {
      const ts = new Date(e.timestamp).toISOString();
      const rel = `+${e.relativeMs}ms`.padStart(9);
      const lvl = e.level.toUpperCase().padEnd(5);
      const head = `${ts} ${rel} ${lvl}  ${e.message}`;
      return e.stack ? `${head}\n${e.stack}` : head;
    })
    .join('\n');
}

export async function initLogStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  sessionStart = Date.now();

  // Load previous session's logs (if any) so the user can inspect a crash
  // from the previous run.
  try {
    const exists = await RNFS.exists(LOG_PATH);
    if (exists) {
      const raw = await RNFS.readFile(LOG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        buffer = (parsed as LogEntry[]).slice(-MAX_ENTRIES);
        notify();
      }
    }
  } catch {
    buffer = [];
  }

  patchConsole();
  hookErrorUtils();

  log.info(`=== Session start ${new Date().toISOString()} ===`);
}

function patchConsole(): void {
  const orig = {
    log:   console.log.bind(console),
    info:  console.info?.bind(console) ?? console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => {
    orig.log(...args);
    pushEntry('info', stringifyArgs(args));
  };
  console.info = (...args: unknown[]) => {
    orig.info(...args);
    pushEntry('info', stringifyArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    pushEntry('warn', stringifyArgs(args));
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    const err = args.find(a => a instanceof Error) as Error | undefined;
    pushEntry('error', stringifyArgs(args), err?.stack);
  };
}

function stringifyArgs(args: readonly unknown[]): string {
  return args
    .map(a => {
      if (a === undefined) return 'undefined';
      if (a === null) return 'null';
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return Object.prototype.toString.call(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

function hookErrorUtils(): void {
  // ErrorUtils is React Native's global JS error handler. Hijack it so any
  // unhandled JS exception (including those thrown inside event handlers)
  // ends up in the buffer.
  const g = globalThis as unknown as {
    ErrorUtils?: {
      setGlobalHandler?: (h: (e: Error, isFatal: boolean) => void) => void;
      getGlobalHandler?: () => (e: Error, isFatal: boolean) => void;
    };
  };
  const eu = g.ErrorUtils;
  if (!eu?.setGlobalHandler) return;
  const prev = eu.getGlobalHandler?.();
  eu.setGlobalHandler((err: Error, isFatal: boolean) => {
    pushEntry('error', `[GLOBAL fatal=${isFatal}] ${err.name}: ${err.message}`, err.stack);
    try {
      prev?.(err, isFatal);
    } catch {
      // swallow
    }
  });
}
