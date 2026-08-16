// The one place in the app that knows what a value looks like before it has a
// meaning. Everything arriving from outside the process — a WebSocket frame, an
// HTTP body, a native module's callback argument — is a `JsonValue` until a
// decoder at that boundary turns it into a domain type. Past the decoder,
// nothing is re-inspected: code branches on the domain value, not on `typeof`.

/** Any value JSON can carry. The widest honest description of undecoded input. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

/** A JSON object whose fields have not been decoded yet. */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** A non-empty string, which is what most wire fields actually have to be. */
export function asText(value: JsonValue | undefined): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

/**
 * Parse a text frame or response body. Returns `undefined` rather than throwing:
 * every caller here is a boundary that drops what it cannot read.
 */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse is typed `any` by the standard library; the value it
    // returns is by construction a JsonValue, and nothing reads it without a
    // guard from this module.
    const parsed = JSON.parse(text) as JsonValue;
    return parsed;
  } catch {
    return undefined;
  }
}
