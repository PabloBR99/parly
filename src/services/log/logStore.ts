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
// Caveat: a hard native crash (SIGSEGV) takes the process down with no
// warning, so the last few queued writes never flush. Nothing in JS can catch
// that — the only defence is logging *before* risky operations, so the most
// recent entry names what was about to happen rather than what happened.
//
// A *fatal JS* error used to look identical, for a much more fixable reason:
// its log entry was written asynchronously while handing the error on killed
// the process synchronously, so the entry describing the crash died with it.
// The global handler now waits for that write before handing off.

import * as RNFS from '@dr.pogodin/react-native-fs';
import type { ErrorUtils as ReactNativeErrorUtils } from 'react-native';

import { asText, isJsonArray, isJsonObject, isNumber, isString, parseJson } from '../../app/json';
import type { JsonValue } from '../../app/json';

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

/** How long a dying process is given to get its last words onto disk. */
const FATAL_FLUSH_BUDGET_MS = 400;

/** Resolve once every write queued so far has landed. Never rejects, and adds
 *  no write of its own — an error-level entry has already forced one, and a
 *  second full serialization is the last thing a dying process needs. */
function whenWritesLand(): Promise<void> {
  return writeChain.then(
    () => undefined,
    () => undefined,
  );
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

const LOG_LEVELS = new Set<string>(
  ['debug', 'info', 'warn', 'error'] satisfies readonly LogLevel[],
);

function isLogLevel(value: JsonValue | undefined): value is LogLevel {
  return isString(value) && LOG_LEVELS.has(value);
}

/** Read back a previous run's log file. The interesting case is the one this
 *  store exists for — the process died mid-write, so the tail is truncated.
 *  Entries that don't decode are dropped, not resurrected as half-objects. */
function decodeLogEntries(raw: string): readonly LogEntry[] {
  const parsed = parseJson(raw);
  if (!isJsonArray(parsed)) return [];
  const entries: LogEntry[] = [];
  for (const value of parsed) {
    const entry = decodeLogEntry(value);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function decodeLogEntry(value: JsonValue): LogEntry | null {
  if (!isJsonObject(value)) return null;
  const { id, timestamp, relativeMs, level, message } = value;
  if (
    !isString(id) ||
    !isNumber(timestamp) ||
    !isNumber(relativeMs) ||
    !isLogLevel(level) ||
    !isString(message)
  ) {
    return null;
  }
  return { id, timestamp, relativeMs, level, message, stack: asText(value.stack) };
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

/** Render whatever a caller passed to a log function. Naming those values more
 *  precisely than "the arguments" would be a fiction. */
function describeArgs(values: readonly unknown[]): string {
  return values
    .map(value => {
      if (value === undefined) return 'undefined';
      if (value === null) return 'null';
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      // Objects render as JSON, primitives through String(). `Object(v) === v`
      // splits them, and unlike `typeof` it does not call null an object.
      if (Object(value) === value) {
        try {
          return JSON.stringify(value);
        } catch {
          return Object.prototype.toString.call(value);
        }
      }
      return String(value);
    })
    .join(' ');
}

/** The same rendering, prefixed with a space so it can be glued to a message. */
function formatRest(rest: readonly unknown[]): string {
  return rest.length === 0 ? '' : ' ' + describeArgs(rest);
}

/** The first Error among the log arguments, whose stack is worth keeping. */
function firstError(values: readonly unknown[]): Error | undefined {
  return values.find((value): value is Error => value instanceof Error);
}

export const log = {
  debug: (msg: string, ...rest: unknown[]) => pushEntry('debug', msg + formatRest(rest)),
  info:  (msg: string, ...rest: unknown[]) => pushEntry('info',  msg + formatRest(rest)),
  warn:  (msg: string, ...rest: unknown[]) => pushEntry('warn',  msg + formatRest(rest)),
  error: (msg: string, ...rest: unknown[]) => {
    pushEntry('error', msg + formatRest(rest), firstError(rest)?.stack);
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
      const restored = decodeLogEntries(raw);
      if (restored.length > 0) {
        buffer = restored.slice(-MAX_ENTRIES);
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
    pushEntry('info', describeArgs(args));
  };
  console.info = (...args: unknown[]) => {
    orig.info(...args);
    pushEntry('info', describeArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    pushEntry('warn', describeArgs(args));
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    pushEntry('error', describeArgs(args), firstError(args)?.stack);
  };
}

function hookErrorUtils(): void {
  // ErrorUtils is React Native's global JS error handler. Hijack it so any
  // unhandled JS exception (including those thrown inside event handlers)
  // ends up in the buffer.
  // SAFETY: the property is optional, so this claims nothing — the check below
  // establishes it. RN declares ErrorUtils as a global *constant*, which does
  // not surface on `typeof globalThis`, and under Jest it is absent entirely,
  // so reading it as a bare identifier would throw.
  const host = globalThis as { ErrorUtils?: ReactNativeErrorUtils };
  const eu = host.ErrorUtils;
  if (!eu?.setGlobalHandler) return;
  const prev = eu.getGlobalHandler?.();
  // `isFatal` is optional on RN's handler contract; absent means non-fatal.
  eu.setGlobalHandler((err: Error, isFatal = false) => {
    pushEntry('error', `[GLOBAL fatal=${isFatal}] ${err.name}: ${err.message}`, err.stack);
    const handOff = () => {
      try {
        prev?.(err, isFatal);
      } catch {
        // swallow
      }
    };
    if (!isFatal) {
      handOff();
      return;
    }
    // Handing off is what ends the process, and the write above is
    // asynchronous — done in the other order it never lands, which is exactly
    // how a fatal error used to leave no trail at all. Wait for the trail,
    // but not forever: if the disk won't answer, the crash still gets
    // reported.
    void Promise.race([
      whenWritesLand(),
      new Promise<void>(r => setTimeout(r, FATAL_FLUSH_BUDGET_MS)),
    ]).then(handOff, handOff);
  });
}
