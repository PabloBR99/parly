// The globals a test swaps out. TypeScript declares them as constants, so this
// is the writable view; the loose types are deliberate, because a test double
// is never the whole real thing. Without it every test that replaced a global
// wrote `as Record<string, unknown>` and lost its types on the way past.

import type { ErrorUtils } from 'react-native';

/** Whatever the code under test reads off a response: a status, maybe a body. */
export interface FakeResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

/** The XMLHttpRequest surface the XHR transport uses. */
export interface FakeXhr {
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

export const globals =
  // SAFETY: all optional, so this claims nothing about what is there — running
  // with no DOMException is a case these tests cover, and Jest never installs
  // an ErrorUtils at all.
  globalThis as {
    fetch?: typeof globalThis.fetch | ((...args: never[]) => Promise<FakeResponse>);
    XMLHttpRequest?: new () => FakeXhr;
    Response?: { readonly prototype: object };
    DOMException?: typeof globalThis.DOMException;
    ErrorUtils?: ErrorUtils;
  };
