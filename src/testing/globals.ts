// Typed access to the globals a test replaces.
//
// Choosing a transport is something `MistralTranslator` does by looking at the
// runtime it finds itself in — whether `fetch` can stream, whether the platform
// has a `DOMException` — so the only way to test that choice is to hand it a
// different runtime. TypeScript declares those globals as constants of their
// real types, and a test double is never the whole real type, so every test
// that swapped one reached for `as Record<string, unknown>` and threw away
// every type it had on the way past. The swap happens once here instead,
// against the contracts the code under test actually uses.
//
// `ErrorUtils` is here for the same reason from the other direction: React
// Native installs it and Jest does not, so the crash-trail test has to.

import type { ErrorUtils as ReactNativeErrorUtils } from 'react-native';

/**
 * What a fetch double answers with. Which parts matter depends on the test:
 * the reachability probe reads only the status, the streaming transport wants
 * a body it can get a reader from.
 */
export interface FetchDoubleResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly body?: StreamingBody | null;
}

export interface StreamingBody {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}

/** A stand-in for `fetch`. Doubles answer the calls a test makes, not the
 *  whole overloaded signature, so their arguments are nobody's business here. */
export type FetchDouble = (...args: never[]) => Promise<FetchDoubleResponse>;

/** The XMLHttpRequest surface the XHR transport depends on. */
export interface StreamingXhr {
  readyState: number;
  status: number;
  responseText: string;
  onreadystatechange: (() => void) | null;
  onerror: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: string): void;
  abort(): void;
}

/** The `Response` surface the streaming feature-detect reads: it looks at the
 *  prototype only, because a Response without a `body` cannot stream. */
export interface ResponseConstructorLike {
  readonly prototype: object;
}

/**
 * The globals a test may replace. Every field is optional — running without a
 * `DOMException` at all is one of the cases these tests cover, and Jest never
 * installs an `ErrorUtils` in the first place.
 */
export interface SwappableGlobals {
  fetch?: typeof globalThis.fetch | FetchDouble;
  XMLHttpRequest?: new () => StreamingXhr;
  Response?: ResponseConstructorLike;
  DOMException?: typeof globalThis.DOMException;
  ErrorUtils?: ReactNativeErrorUtils;
}

export const swappableGlobals =
  // SAFETY: names four globals at the contracts the code under test uses,
  // rather than at the runtime's full declarations. It asserts nothing into
  // existence — every field is optional, so reading one back still says it may
  // be absent.
  globalThis as SwappableGlobals;
