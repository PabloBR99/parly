// JavaScript lets anything be thrown, so what a boundary catches is a cause,
// not yet an error. These turn it into one. Seventeen call sites spelled
// `e instanceof Error ? e : new Error(String(e))` out by hand, and the ones
// that reached for `.message` first printed "[object Object]".

/** The thrown value as an Error, wrapping it only when it was not one. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(describeCause(cause));
}

/** A human-readable line for a thrown value, for logs and notices. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : describeCause(cause);
}

function describeCause(cause: unknown): string {
  // Primitives — strings included — already read as themselves.
  if (Object(cause) !== cause) return String(cause);
  try {
    // A thrown object stringifies to "[object Object]", which names nothing;
    // its JSON at least carries the fields somebody meant to send.
    const rendered = JSON.stringify(cause);
    return rendered === undefined || rendered === '{}' ? String(cause) : rendered;
  } catch {
    return String(cause);
  }
}

/** Anything thrown that names itself. Not every abort is an Error: Node's
 *  DOMException does not extend it, and RN's XHR path throws a plain object. */
interface NamedThrowable {
  readonly name?: string;
}

/** Whether a thrown value is the abort a caller asked for, rather than a
 *  failure. Both transports report cancellation this way. */
export function isAbortError(cause: unknown): boolean {
  if (Object(cause) !== cause) return false;
  // SAFETY: `name` is optional, so this asserts only that the object may carry
  // one — which the comparison checks rather than assumes.
  return (cause as NamedThrowable).name === 'AbortError';
}
