import { buildNameIndex, phoneticKey, repairNames } from '../nameRepair';
import { COMMON_NAMES, DEFAULT_PEOPLE, commonNamesFor } from '../../../app/names';

const PAIR = ['es', 'en'];
const index = buildNameIndex(DEFAULT_PEOPLE, commonNamesFor(PAIR));

const repaired = (text: string): string => repairNames(text, index, PAIR).text;

describe('phoneticKey', () => {
  it('collapses spellings that sound the same', () => {
    expect(phoneticKey('Cycy')).toBe(phoneticKey('Sisi'));
    expect(phoneticKey('Cici')).toBe(phoneticKey('Sisi'));
    expect(phoneticKey('Gonzalo')).toBe(phoneticKey('Gonsalo'));
    expect(phoneticKey('Gonçalo')).toBe(phoneticKey('Gonzalo'));
    expect(phoneticKey('Trinny')).toBe(phoneticKey('Trini'));
    expect(phoneticKey('Pavlo')).toBe(phoneticKey('Pablo'));
    expect(phoneticKey('José')).toBe(phoneticKey('Jose'));
  });

  it('keeps vowels, so near names stay apart', () => {
    expect(phoneticKey('Ana')).not.toBe(phoneticKey('Ane'));
    expect(phoneticKey('Alejandro')).not.toBe(phoneticKey('Alejandra'));
    expect(phoneticKey('Bruno')).not.toBe(phoneticKey('Bruna'));
  });
});

describe('repairNames', () => {
  it('puts a name back the way it is spelled', () => {
    expect(repaired('Me lo dijo Sisi ayer.')).toBe('Me lo dijo Cycy ayer.');
    expect(repaired('Hablé con Gonsalo.')).toBe('Hablé con Gonzalo.');
    expect(repaired('Trinny viene luego')).toBe('Trini viene luego');
  });

  it('matches the longest name first', () => {
    expect(repaired('Vino Jose Antonio.')).toBe('Vino José Antonio.');
  });

  it('leaves a correctly spelled transcript byte-identical', () => {
    const text = 'Bruno y Ana llegan a las ocho.';
    const result = repairNames(text, index, PAIR);
    expect(result.text).toBe(text);
    expect(result.repairs).toEqual([]);
  });

  it('reports what it changed', () => {
    const result = repairNames('Dile a Sisi que venga', index, PAIR);
    expect(result.repairs).toEqual([{ from: 'Sisi', to: 'Cycy' }]);
  });

  it('preserves the punctuation and spacing around what it rewrites', () => {
    expect(repaired('¿Sisi? ¡Sisi!')).toBe('¿Cycy? ¡Cycy!');
  });

  // The guard that decides whether this feature is usable at all: a repair
  // that fires on ordinary speech is worse than a name left misspelled.
  it('never rewrites the ordinary words of either language', () => {
    const sentences = [
      'Ya no es lo que era, pero bueno.',
      'The thing is, I think we can go there.',
      'Está bien, entonces quedamos aquí a las dos.',
      'It was very good, thank you very much.',
    ];
    for (const s of sentences) {
      expect(repairNames(s, index, PAIR).repairs).toEqual([]);
    }
  });

  // The homographs that had to be dropped from COMMON_NAMES, kept here so the
  // next person to add a name discovers the rule by failing this test rather
  // than by hearing their conversation mangled.
  it('does not read ordinary words as the names that were removed for it', () => {
    const sentences = [
      '¿Tú tomas café?',            // Tomás / Thomas
      'Tiene la pared lisa.',       // Lisa
      'Dile que lea el libro.',     // Lea
      'Vimos un león enorme.',      // Leon
      'Esa moto es mía.',           // Mia
      'Es el salvador del equipo.', // Salvador / Salvatore
    ];
    const wide = buildNameIndex(
      DEFAULT_PEOPLE,
      commonNamesFor(['es', 'en', 'de', 'it', 'fr', 'pt']),
    );
    for (const s of sentences) {
      expect(repairNames(s, wide, ['es', 'en']).repairs).toEqual([]);
    }
  });

  it('only repairs towards names it was given', () => {
    const small = buildNameIndex(['Pablo']);
    const result = repairNames('Vino Gonsalo con Pavlo.', small, PAIR);
    expect(result.text).toBe('Vino Gonsalo con Pablo.');
  });

  // Languages spell the same name differently, and the pair decides which
  // list loads first. Neither of those is a reason to rewrite a name the
  // transcript already got right.
  it('leaves a name alone when it is already spelled as some language spells it', () => {
    const bothWays = buildNameIndex([], commonNamesFor(['es', 'en', 'pt']));
    expect(COMMON_NAMES.en).toContain('Anna');
    expect(COMMON_NAMES.es).toContain('Ana');
    expect(repairNames('Vino Anna.', bothWays, ['es', 'en']).repairs).toEqual([]);
    expect(repairNames('Vino Ana.', bothWays, ['es', 'en']).repairs).toEqual([]);
    expect(repairNames('Falou com a Cláudia.', bothWays, ['pt']).repairs).toEqual([]);
  });

  it('lets a person in the conversation outrank another language\'s spelling', () => {
    const mine = buildNameIndex(['Ana'], commonNamesFor(['es', 'en']));
    expect(repairNames('Vino Anna.', mine, ['es', 'en']).text).toBe('Vino Ana.');
  });

  it('does nothing without a glossary', () => {
    const empty = buildNameIndex([]);
    expect(repairNames('Sisi y Gonsalo', empty, PAIR).text).toBe('Sisi y Gonsalo');
  });
});
