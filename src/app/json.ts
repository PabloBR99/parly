// Anything crossing an I/O boundary — a WebSocket frame, an HTTP body — is a
// JsonValue until a decoder there turns it into a domain type.

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export const isString = (v: JsonValue | undefined): v is string => typeof v === 'string';

export const isNumber = (v: JsonValue | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-empty string, which is what most wire fields actually have to be. */
export const asText = (v: JsonValue | undefined): string | undefined =>
  isString(v) && v.length > 0 ? v : undefined;

/** Boundaries drop what they cannot read, so this answers undefined instead
 *  of throwing. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse is typed `any`; what it returns is a JsonValue by
    // construction, and nothing reads it without a guard from this module.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
