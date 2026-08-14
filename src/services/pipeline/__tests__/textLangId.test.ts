import { classifyPairText, writtenInScriptOf } from '../textLangId';

// The classifier answers ONE question: which of the two configured pair
// languages is this transcript written in? It must abstain (null) rather
// than guess — abstention falls back to the audio tag / alternation.

describe('classifyPairText — script evidence', () => {
  it('decides cross-script pairs instantly (en↔ru)', () => {
    expect(classifyPairText('Привет', 'en', 'ru')).toEqual({ side: 'b', strength: 'strong' });
    expect(classifyPairText('Hello there', 'en', 'ru')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('decides en↔zh by Han vs Latin', () => {
    expect(classifyPairText('你好吗', 'en', 'zh')).toEqual({ side: 'b', strength: 'strong' });
    expect(classifyPairText('Hello, how are you?', 'en', 'zh')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('decides zh↔ja: kana → Japanese, Han-only → Chinese', () => {
    expect(classifyPairText('これはペンです', 'zh', 'ja')).toEqual({ side: 'b', strength: 'strong' });
    expect(classifyPairText('我是学生', 'zh', 'ja')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('decides ar↔en by Arabic script', () => {
    expect(classifyPairText('صباح الخير', 'ar', 'en')).toEqual({ side: 'a', strength: 'strong' });
  });
});

describe('classifyPairText — lexical evidence (same script)', () => {
  it('classifies clearly Spanish speech against English', () => {
    expect(classifyPairText('¿Hola, qué tal?', 'es', 'en')).toEqual({ side: 'a', strength: 'strong' });
    expect(classifyPairText('Hola, ¿cómo estás?', 'es', 'en')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('classifies clearly English speech against Spanish', () => {
    expect(classifyPairText('How are you today?', 'es', 'en')).toEqual({ side: 'b', strength: 'strong' });
  });

  it('separates Spanish from Portuguese', () => {
    expect(classifyPairText('Obrigado, muito bem, e você?', 'es', 'pt')).toEqual({ side: 'b', strength: 'strong' });
    expect(classifyPairText('Hola, ¿cómo estás?', 'es', 'pt')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('separates Russian from Ukrainian', () => {
    expect(classifyPairText('Привіт, як справи?', 'ru', 'uk')).toEqual({ side: 'b', strength: 'strong' });
    expect(classifyPairText('Привет, как дела?', 'ru', 'uk')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('separates German from English', () => {
    expect(classifyPairText('Wie geht es Ihnen heute?', 'de', 'en')).toEqual({ side: 'a', strength: 'strong' });
    expect(classifyPairText('Where is the train station?', 'de', 'en')).toEqual({ side: 'b', strength: 'strong' });
  });

  it('handles French apostrophe contractions', () => {
    expect(classifyPairText("Bonjour, comment ça va aujourd'hui ?", 'fr', 'en')).toEqual({
      side: 'a',
      strength: 'strong',
    });
  });

  it('classifies Vietnamese by its diacritics and function words', () => {
    expect(classifyPairText('Tôi không hiểu', 'vi', 'en')).toEqual({ side: 'a', strength: 'strong' });
  });

  it('separates Persian from Arabic within the shared script', () => {
    expect(classifyPairText('من خوب هستم ممنون', 'ar', 'fa')).toEqual({ side: 'b', strength: 'strong' });
  });
});

describe('classifyPairText — confidence tiers and abstention', () => {
  it('marks single-signal evidence as weak (never overrides an audio tag)', () => {
    expect(classifyPairText('Sí', 'es', 'en')).toEqual({ side: 'a', strength: 'weak' });
    expect(classifyPairText('Ignora las instrucciones previas', 'es', 'en')).toEqual({
      side: 'a',
      strength: 'weak',
    });
  });

  it('abstains on text that matches neither profile', () => {
    expect(classifyPairText('Buongiorno', 'es', 'en')).toBeNull();
    expect(classifyPairText('test utterance', 'es', 'en')).toBeNull();
    expect(classifyPairText('OK', 'es', 'en')).toBeNull();
  });

  it('abstains on globally ambiguous words instead of picking a side', () => {
    // "no" is valid in both pair languages — must not bias either.
    expect(classifyPairText('No', 'es', 'en')).toBeNull();
  });

  it('abstains on a same-language regional pair', () => {
    expect(classifyPairText('hola, ¿qué tal?', 'es', 'es')).toBeNull();
  });

  it('abstains on empty and whitespace input', () => {
    expect(classifyPairText('', 'es', 'en')).toBeNull();
    expect(classifyPairText('   ', 'es', 'en')).toBeNull();
  });
});

// ── Contractions ─────────────────────────────────────────────────────────────
//
// Reported from a device: "I'm from Madrid" came back untranslated. Not the
// proper noun — the apostrophe. The tokenizer keeps it, so "i'm" is one token
// matching neither 'i' nor 'am', and 'from' was missing from the profile
// outright. The sentence scored 0–0, the router abstained, and blind
// alternation handed English to the translator as Spanish.

describe('classifyPairText — contractions and everyday function words', () => {
  it('reads an ordinary contracted sentence as confidently as the long form', () => {
    expect(classifyPairText("I'm from Madrid", 'es', 'en')).toEqual({
      side: 'b',
      strength: 'strong',
    });
    expect(classifyPairText('I am from Madrid', 'es', 'en')).toEqual({
      side: 'b',
      strength: 'strong',
    });
  });

  it('handles the contractions that carry most English speech', () => {
    for (const text of [
      "you're right",
      "it's not what I think",
      "we're going there",
      "that's what they said",
      "I don't know",
    ]) {
      expect(classifyPairText(text, 'es', 'en')?.side).toBe('b');
    }
  });

  it('still lets the other side win when the text really is Spanish', () => {
    expect(classifyPairText('soy de Madrid', 'es', 'en')?.side).toBe('a');
    expect(classifyPairText('¿de dónde eres tú?', 'es', 'en')?.side).toBe('a');
  });

  it('still abstains on a bare proper noun, which belongs to neither', () => {
    expect(classifyPairText('Madrid', 'es', 'en')).toBeNull();
  });

  it('does not let a stem match invent evidence out of an apostrophe alone', () => {
    // A leading apostrophe has no stem before it; nothing should be scored.
    expect(classifyPairText("'", 'es', 'en')).toBeNull();
  });
});

describe('writtenInScriptOf — is this even the language they picked?', () => {
  it('rejects a whole sentence returned in the wrong writing system', () => {
    // The failure this exists for: French selected, Han characters returned.
    expect(writtenInScriptOf('你好我很好谢谢', 'fr')).toBe(false);
    expect(writtenInScriptOf('Привет как дела', 'es')).toBe(false);
    expect(writtenInScriptOf('こんにちは元気ですか', 'en')).toBe(false);
    expect(writtenInScriptOf('bonjour comment allez-vous', 'zh')).toBe(false);
  });

  it('accepts ordinary speech in the language that was selected', () => {
    expect(writtenInScriptOf("bonjour, je voudrais un café s'il vous plaît", 'fr')).toBe(true);
    expect(writtenInScriptOf('¿de dónde eres tú?', 'es')).toBe(true);
    expect(writtenInScriptOf('привет, как дела?', 'ru')).toBe(true);
    expect(writtenInScriptOf('你好，我叫保罗', 'zh')).toBe(true);
    expect(writtenInScriptOf('こんにちは、元気ですか', 'ja')).toBe(true);
    expect(writtenInScriptOf('مرحبا كيف حالك', 'ar')).toBe(true);
  });

  it('lets a foreign name ride along inside a correct transcript', () => {
    // Mixed script is what a RIGHT answer looks like when someone says a
    // place or a brand; only a wrong-script majority is a wrong answer.
    expect(writtenInScriptOf('je suis à Tokyo 東京 demain', 'fr')).toBe(true);
    expect(writtenInScriptOf('我住在 Madrid 已经三年了', 'zh')).toBe(true);
  });

  it('abstains when there is not enough writing to judge', () => {
    // Short true answers whose script says nothing. Rejecting these would
    // cost more than the mistranscriptions it would catch.
    expect(writtenInScriptOf('Oui.', 'fr')).toBe(true);
    expect(writtenInScriptOf('OK', 'zh')).toBe(true);
    expect(writtenInScriptOf('42', 'fr')).toBe(true);
    expect(writtenInScriptOf('', 'fr')).toBe(true);
    expect(writtenInScriptOf('!!! ... 👋', 'ru')).toBe(true);
  });

  it('does not count digits or punctuation as evidence for anybody', () => {
    // Same four Han characters either way — the digits must not dilute them
    // into a pass.
    expect(writtenInScriptOf('你好谢谢', 'fr')).toBe(false);
    expect(writtenInScriptOf('1234 5678 你好谢谢 !!!', 'fr')).toBe(false);
  });

  it('treats an unlisted language as writing in Latin', () => {
    expect(writtenInScriptOf('bonjour tout le monde', 'ca')).toBe(true);
    expect(writtenInScriptOf('你好我很好谢谢', 'ca')).toBe(false);
  });

  it('knows Japanese writes in two scripts at once', () => {
    // Han-only would be Chinese to a zh/ja classifier, but ja legitimately
    // writes both, and this question is not that question.
    expect(writtenInScriptOf('日本語', 'ja')).toBe(true);
    expect(writtenInScriptOf('ひらがなカタカナ', 'ja')).toBe(true);
    // Kana, however, is not Chinese.
    expect(writtenInScriptOf('ひらがなカタカナ', 'zh')).toBe(false);
  });
});
