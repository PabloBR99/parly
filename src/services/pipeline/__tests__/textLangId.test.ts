import { classifyPairText } from '../textLangId';

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
