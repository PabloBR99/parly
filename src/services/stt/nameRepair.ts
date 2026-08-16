// nameRepair — put the names back the way they are spelled.
//
// Voxtral does not usually *mishear* a familiar name; it writes down what it
// heard using ordinary orthography, because a name is precisely the word its
// language model has no expectation for. "Cycy" comes back "Sisi" or "Cici",
// "Gonzalo" comes back "Gonsalo", "Trini" comes back "Trinny". Every one of
// those is a correct phonetic reading of the audio and a wrong word on screen.
//
// That failure mode is *deterministic*, which is why it is worth fixing here
// rather than asking a model about it: two spellings of the same sounds map to
// the same phonetic key, so the repair is a dictionary lookup with no latency
// and no judgement.
//
// Which is also the limit. This repairs same-sound / different-spelling and
// nothing else. A name genuinely misheard — "Alejandro" heard as "Alexandre",
// "Trini" heard as "sí ni" — has a different key and is left alone. Edit
// distance would catch some of those and would also turn "Alejandra" into
// "Alejandro" and "el ala" into "el Ale", which is a worse app: a repair that
// fires on ordinary speech destroys trust in every turn, while a missed name is
// the status quo. The near misses are handed to the translator instead
// (see MistralTranslator's glossary block), which has the sentence in view and
// can decide what a table of keys cannot.
//
// Guards, in the order they apply:
//   · a token that is a function word in either language of the pair is never
//     touched (the pair's own lexicon from textLangId decides);
//   · keys shorter than 3 characters never match;
//   · a span already spelled exactly like the glossary entry is left alone,
//     so the common case rewrites nothing.

import { isFunctionWord } from '../pipeline/textLangId';

/** Longest glossary entry we will try to match, in words ("José Antonio"). */
const MAX_ENTRY_WORDS = 3;
const MIN_KEY_LEN = 3;

export interface NameIndex {
  /** phonetic key → canonical spelling. */
  readonly byKey: ReadonlyMap<string, string>;
  /** Keys contributed by the people in the conversation, which outrank
   *  everything: their spelling is a decision, not a default. */
  readonly personalKeys: ReadonlySet<string>;
  /** Every spelling in the index, lowercased. A transcript already spelling a
   *  name one of these ways is not making a mistake to correct. */
  readonly spellings: ReadonlySet<string>;
  /** Longest entry in the index, in words. */
  readonly maxWords: number;
}

export interface NameRepair {
  readonly from: string;
  readonly to: string;
}

export interface RepairResult {
  readonly text: string;
  readonly repairs: readonly NameRepair[];
}

/**
 * A spelling-insensitive key for one word: two spellings of the same sounds
 * produce the same key.
 *
 * The rewrites are ordered, and the order is the whole design — each one
 * consumes the letters the next would otherwise misread. It is deliberately a
 * *shared* key space for Latin-script languages rather than one per language:
 * the transcript can come back in either language of the pair, and a name is
 * the one word likely to be written in the other's orthography.
 *
 * Not Soundex or Metaphone: those drop vowels, which is fine for surnames in a
 * census and fatal for "Ana" vs "Ane" vs "Ene".
 */
export function phoneticKey(word: string): string {
  let s = word
    .replace(/[çÇ]/g, 's')       // before the accent strip, which would make it 'c'
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (s.length === 0) return '';

  s = s.replace(/x/g, 'ks');     // before 'ch'/'sh' claim the letter x as a marker
  s = s.replace(/ph/g, 'f');
  s = s.replace(/ch|sh/g, 'x');  // one post-alveolar class: Chema/Shema/Xema
  s = s.replace(/qu/g, 'k');
  s = s.replace(/gu([ei])/g, 'g$1');
  s = s.replace(/g([ei])/g, 'j$1');
  // Silent h, but only inside a word: "Thomas"→tomas, "Alhambra"→alambra.
  // A leading h is left alone, and that asymmetry is load-bearing — dropping
  // it made English aspirates vanish, which collapsed "Hannah" onto "Ana" and,
  // worse, the Spanish interjection "hale" onto the name "Ale".
  s = s.charAt(0) + s.slice(1).replace(/h/g, '');
  s = s.replace(/c([eiy])/g, 's$1');
  s = s.replace(/z/g, 's');
  s = s.replace(/c/g, 'k');
  s = s.replace(/[vw]/g, 'b');   // betacism: Pavlo→pablo
  s = s.replace(/ll/g, 'y');
  s = s.replace(/y/g, 'i');
  s = s.replace(/(.)\1+/g, '$1'); // Trinny→trini, Sissy→sisi
  return s;
}

/** Key for a multi-word entry — the words' keys, joined. */
function phraseKey(words: readonly string[]): string {
  return words.map(phoneticKey).join(' ');
}

/**
 * Build the lookup from the two lists, kept apart because they answer to
 * different rules.
 *
 * `people` are the humans in this conversation and their spelling is a
 * decision: it wins collisions and it overrules any other spelling of the same
 * sounds. `common` are the ordinary names of the pair's languages, and they are
 * only a default — which matters because languages spell the same name
 * differently. "Ana" and "Anna" share a key, as do "Claudia" and "Cláudia" and
 * "Sara" and "Sarah"; without the distinction, whichever language's list
 * happened to load first would "correct" the other's perfectly good spelling,
 * and which one that was depended on the order the pair was configured in.
 */
export function buildNameIndex(
  people: readonly string[],
  common: readonly string[] = [],
): NameIndex {
  const byKey = new Map<string, string>();
  const personalKeys = new Set<string>();
  const spellings = new Set<string>();
  let maxWords = 1;
  const add = (name: string, personal: boolean) => {
    const words = name.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0 || words.length > MAX_ENTRY_WORDS) return;
    const key = phraseKey(words);
    if (key.replace(/\s/g, '').length < MIN_KEY_LEN) return;
    if (!byKey.has(key)) byKey.set(key, name.trim());
    if (personal) personalKeys.add(key);
    spellings.add(name.trim().toLowerCase());
    if (words.length > maxWords) maxWords = words.length;
  };
  for (const name of people) add(name, true);
  for (const name of common) add(name, false);
  return { byKey, personalKeys, spellings, maxWords };
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Word tokens with their offsets, so the repair can rewrite in place and
 *  leave every space and comma exactly where the transcript put it. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Rewrite the names in `text` to their glossary spelling.
 *
 * `langs` are the primary subtags of the conversation pair; they decide which
 * lexicon protects ordinary words from being read as names.
 */
export function repairNames(
  text: string,
  index: NameIndex,
  langs: readonly string[] = [],
): RepairResult {
  if (text.length === 0 || index.byKey.size === 0) return { text, repairs: [] };

  const tokens = tokenize(text);
  if (tokens.length === 0) return { text, repairs: [] };

  const repairs: NameRepair[] = [];
  let out = '';
  let cursor = 0;
  let i = 0;

  while (i < tokens.length) {
    let matched = false;
    const maxSpan = Math.min(index.maxWords, tokens.length - i);

    // Longest span first: "José Antonio" must not be taken as "José".
    for (let span = maxSpan; span >= 1 && !matched; span--) {
      const words = tokens.slice(i, i + span);
      if (words.some((t) => isFunctionWord(t.text, langs))) continue;

      const key = phraseKey(words.map((t) => t.text));
      if (key.replace(/\s/g, '').length < MIN_KEY_LEN) continue;

      const canonical = index.byKey.get(key);
      if (canonical === undefined) continue;

      const start = words[0].start;
      const end = words[words.length - 1].end;
      const original = text.slice(start, end);
      matched = true;
      // Already spelled as somebody's name, just not as this list's first
      // choice. Only a person in the conversation outranks that — otherwise
      // this "corrects" a Portuguese Cláudia into a Spanish Claudia.
      const alreadyAName =
        !index.personalKeys.has(key) && index.spellings.has(original.toLowerCase());
      if (original !== canonical && !alreadyAName) {
        out += text.slice(cursor, start) + canonical;
        cursor = end;
        repairs.push({ from: original, to: canonical });
      }
      i += span;
    }

    if (!matched) i++;
  }

  if (repairs.length === 0) return { text, repairs: [] };
  out += text.slice(cursor);
  return { text: out, repairs };
}
