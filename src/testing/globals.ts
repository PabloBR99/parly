// The globals a test swaps out. TypeScript declares them as constants, so this
// is the writable view — without it, tests wrote `as Record<string, unknown>`.

import type { ErrorUtils } from 'react-native';

/** What the code under test reads off a response. */
export interface FakeResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

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
