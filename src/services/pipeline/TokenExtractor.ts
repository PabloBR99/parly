// TokenExtractor — extracts new tokens from streaming ASR partial results.
//
// Compares the current partial transcript against the previous one to identify
// newly added tokens. Used by WaitKTranslator to know when source tokens arrive.
//
// Tokenization is simple whitespace-based splitting. For ASR output this is
// sufficient — the models emit word-level tokens separated by spaces.

/**
 * Extract newly added tokens from a growing partial transcript.
 *
 * Returns the new tokens that appeared at the end of `current` compared
 * to `previous`. If current is shorter or completely different, returns
 * all tokens in current (treat as a reset).
 */
export function extractNewTokens(
  previous: string,
  current: string,
): readonly string[] {
  const prevTokens = tokenize(previous);
  const currTokens = tokenize(current);

  if (currTokens.length === 0) return [];

  // Fast path: current extends previous
  if (currTokens.length > prevTokens.length) {
    // Check if prefix matches
    let prefixMatch = true;
    for (let i = 0; i < prevTokens.length; i++) {
      if (prevTokens[i] !== currTokens[i]) {
        prefixMatch = false;
        break;
      }
    }

    if (prefixMatch) {
      return currTokens.slice(prevTokens.length);
    }
  }

  // Fallback: find the longest matching prefix
  let matchLen = 0;
  const maxCheck = Math.min(prevTokens.length, currTokens.length);
  for (let i = 0; i < maxCheck; i++) {
    if (prevTokens[i] === currTokens[i]) {
      matchLen = i + 1;
    } else {
      break;
    }
  }

  return currTokens.slice(matchLen);
}

/** Simple whitespace tokenizer — sufficient for ASR word output. */
function tokenize(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}
