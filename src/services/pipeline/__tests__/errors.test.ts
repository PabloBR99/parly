import { classifyError } from '../errors';

describe('classifyError', () => {
  it('maps auth failures to keyInvalid', () => {
    expect(classifyError('HTTP 401: Authentication failed (check API key).')).toBe('keyInvalid');
    expect(classifyError('HTTP 403: forbidden')).toBe('keyInvalid');
  });

  it('maps rate limiting to rateLimit', () => {
    expect(classifyError('HTTP 429: Rate limit exceeded.')).toBe('rateLimit');
  });

  it('maps connection plumbing to connectionDropped', () => {
    expect(
      classifyError('Voxtral handshake failed: WebSocket closed before session.created (code=1006)'),
    ).toBe('connectionDropped');
    expect(classifyError('Translation request failed: TypeError: Network request failed')).toBe(
      'connectionDropped',
    );
    expect(classifyError('Voxtral WebSocket handshake timeout')).toBe('connectionDropped');
    expect(classifyError('HTTP 503: Mistral service error.')).toBe('connectionDropped');
  });

  it('suppresses user cancellation entirely', () => {
    expect(classifyError('Translation cancelled')).toBeNull();
    expect(classifyError('Voxtral handshake cancelled')).toBeNull();
  });

  it('falls back to generic for anything unrecognized', () => {
    expect(classifyError('Pipeline error: undefined is not a function')).toBe('generic');
  });

  it('specific matches win over the broad connection bucket', () => {
    // Contains both "request failed"-ish plumbing AND a 401 — auth wins.
    expect(classifyError('WebSocket error: HTTP 401 during handshake')).toBe('keyInvalid');
  });
});
