// Typed access to the globals a test replaces.
//
// MistralTranslator picks its transport by looking at the runtime it finds
// itself in, so testing that choice means handing it a different runtime. A
// test double is never the whole real type, which is why every test that
// swapped a global reached for `as Record<string, unknown>` and lost its types
// on the way past. The swap happens once here, typed against the contracts the
// code under test actually uses. `ErrorUtils` is here for the opposite reason:
// React Native installs it and Jest does not.

import type { ErrorUtils as ReactNativeErrorUtils } from 'react-native';

/** What a fetch double answers with. Which parts matter depends on the test:
 *  the reachability probe reads a status, the transport wants a body. */
export interface FetchDoubleResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly body?: StreamingBody | null;
}

export interface StreamingBody {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}

/** A stand-in for `fetch`. Doubles answer the calls a test makes, not the whole
 *  overloaded signature, so their arguments are nobody's business here. */
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

/** The `Response` surface the streaming feature-detect reads: the prototype
 *  only, because a Response without a `body` cannot stream. */
export interface ResponseConstructorLike {
  readonly prototype: object;
}

/** Every field is optional — running with no `DOMException` at all is one of
 *  the cases these tests cover. */
export interface SwappableGlobals {
  fetch?: typeof globalThis.fetch | FetchDouble;
  XMLHttpRequest?: new () => StreamingXhr;
  Response?: ResponseConstructorLike;
  DOMException?: typeof globalThis.DOMException;
  ErrorUtils?: ReactNativeErrorUtils;
}

export const swappableGlobals =
  // SAFETY: names these globals at the contracts the code under test uses, not
  // the runtime's full declarations. Every field is optional, so it asserts
  // nothing into existence — reading one back still says it may be absent.
  globalThis as SwappableGlobals;
