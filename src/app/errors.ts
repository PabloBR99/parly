// JavaScript lets anything be thrown, so what a boundary catches is a cause,
// not yet an error. Seventeen call sites spelled the conversion out by hand,
// and the ones that reached for `.message` first printed "[object Object]".

/** The thrown value as an Error, wrapping it only when it was not one. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(errorMessage(cause));
}

/** A human-readable line for a thrown value, for logs and notices. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause !== 'object' || cause === null) return String(cause);
  // A thrown object stringifies to "[object Object]", which names nothing.
  // Its JSON carries the fields somebody meant to send — unless there are
  // none to carry, as with a DOMException, whose toString is the better one.
  try {
    const json = JSON.stringify(cause);
    return json === undefined || json === '{}' ? String(cause) : json;
  } catch {
    return String(cause);
  }
}

/** Whether a thrown value is the abort a caller asked for. Not every abort is
 *  an Error: Node's DOMException is not, and RN's XHR throws a plain object. */
export function isAbortError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause
    && cause.name === 'AbortError';
}
