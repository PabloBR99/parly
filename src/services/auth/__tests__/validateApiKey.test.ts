/**
 * The API key is the one string in this app that arrives entirely unexamined
 * and goes straight into an HTTP header. Reported from a device as a crash:
 * the diagnostics log had been pasted into the key field, and the app closed
 * with no error and no trail on the next request — the failure was below the
 * language, inside the platform's networking layer, where no catch of ours
 * is standing.
 */

import { isSendableKey, validateMistralApiKey } from '../validateApiKey';

// What was actually in the key field: a few kilobytes of it, newlines
// throughout, and em dashes and arrows that are not ASCII at all.
const PASTED_LOG = [
  '2026-08-11T09:47:10.871Z    +117ms INFO   === Session start ===',
  '2026-08-11T09:47:19.099Z   +8345ms INFO   [pair] start: partner=en self=es',
  '2026-08-11T09:47:27.781Z  +17027ms INFO   [orch/hf] enabling — pair=es↔en',
].join('\n');

describe('isSendableKey — what may become an Authorization header', () => {
  it('refuses the diagnostics log somebody pasted into the key field', () => {
    expect(isSendableKey(PASTED_LOG)).toBe(false);
  });

  it('refuses anything with a line break in it, however short', () => {
    expect(isSendableKey('abcdefgh\nijklmnop')).toBe(false);
    expect(isSendableKey('abcdefgh\r\nijklmnop')).toBe(false);
  });

  it('refuses characters no header can carry', () => {
    // The ones a copy out of a web page or a chat window actually brings:
    // a non-breaking space, an em dash, a curly quote.
    expect(isSendableKey('abcdefgh ijklmnop')).toBe(false);
    expect(isSendableKey('abcdefgh—ijklmnop')).toBe(false);
    expect(isSendableKey('abcdefgh’ijklmnop')).toBe(false);
    expect(isSendableKey('abcdefgh ijklmnop')).toBe(false); // plain space
  });

  it('refuses nothing at all, and refuses more than any credential could be', () => {
    expect(isSendableKey('')).toBe(false);
    expect(isSendableKey('   ')).toBe(false);
    expect(isSendableKey('\n')).toBe(false);
    expect(isSendableKey('x'.repeat(513))).toBe(false);
  });

  it('lets a short wrong key through to be refused by the server', () => {
    // Not this guard's call. "asdf" can be sent, so it gets sent, and comes
    // back a clean 401 — which is the honest account of it. A length floor
    // here would be a guess at the shape of a credential, and the day the
    // issuer changes that shape the guess locks someone out.
    expect(isSendableKey('asdf')).toBe(true);
  });

  it('accepts an ordinary key, including one copied with a trailing newline', () => {
    const key = 'K7fQ2mXp9LzR4tYw8NcV5bH3jD6gS1aE';
    expect(isSendableKey(key)).toBe(true);
    expect(isSendableKey(`  ${key}\n`)).toBe(true);
  });

  it('does not guess at the shape of a key beyond being sendable', () => {
    // No prefix, no alphabet, no length anyone would recognise — the day the
    // issuer changes the format, a stricter check here locks people out of a
    // perfectly good key.
    expect(isSendableKey('sk-proj_0000-1111.2222~3333/4444+5555')).toBe(true);
    expect(isSendableKey('%^&*()[]{}<>?!@#$'.repeat(2))).toBe(true);
  });
});

describe('validateMistralApiKey — malformed never reaches the network', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('reports malformed without sending anything at all', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(validateMistralApiKey(PASTED_LOG)).resolves.toEqual({ status: 'malformed' });

    // The whole point: the string never got as far as the platform.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still tells a rejected key apart from an unusable one', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch;

    // Well-formed and refused by the server is a different problem with a
    // different fix — that key exists, it just does not work any more.
    await expect(validateMistralApiKey('K7fQ2mXp9LzR4tYw8NcV5bH3jD6gS1aE'))
      .resolves.toEqual({ status: 'invalid' });
  });
});
