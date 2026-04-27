// validateApiKey — quick liveness check against Mistral.
//
// Hits GET /v1/models with the candidate key and a short timeout. The
// endpoint costs nothing and gates on Authorization, so it's the cleanest
// "does this key work?" probe.

const MODELS_ENDPOINT = 'https://api.mistral.ai/v1/models';
const TIMEOUT_MS = 6_000;

export type KeyValidation =
  | { readonly status: 'ok' }
  | { readonly status: 'invalid' }
  | { readonly status: 'network' }
  | { readonly status: 'unknown'; readonly httpStatus: number };

export async function validateMistralApiKey(key: string): Promise<KeyValidation> {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { status: 'invalid' };

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
