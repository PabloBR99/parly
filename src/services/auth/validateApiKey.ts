// validateApiKey — quick liveness check against Mistral.
//
// Hits GET /v1/models with the candidate key and a short timeout. The
// endpoint costs nothing and gates on Authorization, so it's the cleanest
// "does this key work?" probe.

const MODELS_ENDPOINT = 'https://api.mistral.ai/v1/models';
const TIMEOUT_MS = 6_000;

export type KeyValidation =
  | { readonly status: 'ok' }
  /** Cannot be a key at all — never sent anywhere. */
  | { readonly status: 'malformed' }
  /** Well-formed, and the server said no. */
  | { readonly status: 'invalid' }
  | { readonly status: 'network' }
  | { readonly status: 'unknown'; readonly httpStatus: number };

/**
 * Whether `key` can be put in an `Authorization` header at all.
 *
 * This is a safety check before it is a validation one. An HTTP header value
 * may only hold printable ASCII, and Android's HTTP stack raises on anything
 * else from deep inside the networking layer, where no `catch` of ours is
 * standing. A pasted key is the one string in this app that arrives entirely
 * unexamined and goes straight into a header — a stray newline off the end of
 * a copy, a non-breaking space out of a web page, or the wrong clipboard
 * entry altogether, and it is the platform that decides what happens next.
 *
 * So nothing unexaminable is ever handed over. Trimming first means the
 * ordinary copy-with-trailing-newline still works; what remains must be one
 * solid run of printable ASCII, which every API key is and no accident is.
 * This was reported from a device as a crash: the diagnostics log had been
 * pasted into the key field, and a few kilobytes of newlines and em dashes
 * went out as a header on the next request. The app closed with no error and
 * no trail, because the failure was below the language.
 *
 * Deliberately not a format check: no prefix, no length floor, no alphabet
 * beyond "could be sent". Guessing at the shape of a key is how you lock
 * someone out of a perfectly good one the day the issuer changes it, and a
 * short wrong key is the server's to refuse — it gets a clear 401 and an
 * honest "rejected", which is the truth about it. The only bound is a ceiling
 * set where no credential could live: an oversized header is a hazard in its
 * own right, whatever it spells.
 */
export function isSendableKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  return /^[\x21-\x7e]+$/.test(trimmed);
}

export async function validateMistralApiKey(key: string): Promise<KeyValidation> {
  const trimmed = key.trim();
  if (!isSendableKey(trimmed)) return { status: 'malformed' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: ctrl.signal,
    });
    if (res.status === 200) return { status: 'ok' };
    if (res.status === 401 || res.status === 403) return { status: 'invalid' };
    return { status: 'unknown', httpStatus: res.status };
  } catch {
    return { status: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
