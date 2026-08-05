// Failure humanization (audit C1).
//
// Raw pipeline errors read like plumbing — "Voxtral handshake failed:
// WebSocket closed before session.created (code=1006)", "HTTP 429: Rate
// limit exceeded." — and used to land verbatim on the conversation surface,
// on the half of the one person who couldn't act on them. The store now
// carries a NoticeKey instead of a sentence; each half renders the key in
// its reader's language (i18n/strings.ts). The raw string still goes to the
// log buffer, which is where diagnostics belong.

import type { NoticeKey } from '../../store/conversationStore';

/**
 * Map a raw service error message to a notice key, or null when the
 * "failure" is user intent (a cancelled turn) and nothing should render.
 * Specific matches (auth, rate limit) run before the broad connection
 * bucket so an HTTP status never drowns in the generic copy.
 */
export function classifyError(message: string): NoticeKey | null {
  if (/cancell/i.test(message)) return null;
  if (/\b401\b|\b403\b|authentication|api key/i.test(message)) return 'keyInvalid';
  if (/\b429\b|rate limit/i.test(message)) return 'rateLimit';
  if (/handshake|websocket|network|timeout|request failed|\b5\d\d\b|service error/i.test(message)) {
    return 'connectionDropped';
  }
  return 'generic';
}
