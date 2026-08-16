// names — the glossary the transcript is repaired against.
//
// Proper nouns are the words an ASR has least help with: they carry no
// language-model support, they are exactly what Voxtral's realtime socket
// cannot be biased towards (its session accepts `audio_format` and
// `target_streaming_delay_ms`, and nothing else — the `context_bias` parameter
// exists only on the HTTP transcription endpoint, which needs a finished file),
// and they are the words a listener notices being wrong. So the app carries its
// own list and repairs the transcript after the fact.
//
// Two lists, two different jobs:
//
//   PEOPLE — the names of the actual humans in this conversation, editable in
//     Settings. Small, personal, and worth putting in front of the translator
//     as well, where an LLM with the sentence in view can catch what a
//     phonetic match cannot.
//
//   COMMON_NAMES — the ordinary given names of each language, used ONLY by the
//     local phonetic repair. They never go into a prompt: a few hundred names
//     would cost tokens on every single turn to help with a name the speakers
//     probably never say.
//
// The curation rule for COMMON_NAMES, which matters more than its length:
// a name that is also an ordinary word in any language it might be paired with
// is left out. "Rosa", "Clara", "Alba", "Pilar", "Marina", "Rocío", "Ángel",
// "Salvador", "Marcos", "Mark", "Rose", "Grace", "Will", "Frank", "Sean",
// "Claire", "Olivier", "Chiara", "Marco" — every one of them would turn an
// ordinary sentence into a name, and a repair that fires on ordinary speech is
// far worse than a name left misspelled. When in doubt, the name is out.
//
// It bites ACROSS languages too, not just inside one, because the pair decides
// which lists are loaded together: "Thomas" and "Tomás" both had to go (Spanish
// "tú tomas"), and so did "Lisa" ("lisa"), "Leon" and "Lea"/"Léa" ("león",
// "que lea"), "Mia" ("mía"), "Jean" (denim), "Pierre" (stone) and "Salvatore"
// (saviour). Every one of those sentences is in nameRepair's test file, so the
// next person to add a name to these lists finds out from a failing test
// rather than from a conversation.

/**
 * The people in this conversation. Seeded with the names the app's owner asked
 * for; editable in Settings, one per line or comma-separated.
 *
 * Spelling is a choice the list makes: whatever is written here is what the
 * transcript will be rewritten to. "Cycy" and "Sisi" are the same name and
 * sound identical, so only one of them can win — swap the order to change
 * which.
 */
export const DEFAULT_PEOPLE: readonly string[] = [
  'Pablo',
  'Cycy',
  'Ana',
  'Trini',
  'José Antonio',
  'Bruno',
  'Ale',
  'Alejandro',
  'Gonzalo',
];

/**
 * Given names by language, for the phonetic repair only. Roughly the forty
 * most common of each, minus every homograph (see the curation rule above).
 */
export const COMMON_NAMES = {
  es: [
    'Antonio', 'Manuel', 'Francisco', 'Juan', 'David', 'Javier', 'Sergio',
    'Carlos', 'Miguel', 'Daniel', 'Adrián', 'Álvaro', 'Diego', 'Rubén',
    'Iván', 'Óscar', 'Andrés', 'Raúl', 'Jorge', 'Fernando', 'Ignacio',
    'Enrique', 'Ricardo', 'Guillermo', 'Mario', 'Hugo', 'Martín', 'Nicolás',
    'Sebastián', 'Emilio', 'Julián', 'Ramón', 'Vicente', 'Roberto',
    'Alberto', 'Eduardo', 'Rafael', 'Santiago', 'Jaime', 'Pedro', 'Felipe',
    'Joaquín', 'Cristian', 'Aitor', 'Iker',
    'Ana', 'María', 'Carmen', 'Elena', 'Marta', 'Laura', 'Sara', 'Paula',
    'Cristina',
    'Isabel', 'Irene', 'Julia', 'Andrea', 'Natalia', 'Patricia', 'Nuria',
    'Beatriz', 'Silvia', 'Raquel', 'Teresa', 'Susana', 'Eva', 'Nerea',
    'Aitana', 'Valeria', 'Daniela', 'Carla', 'Sofía', 'Claudia', 'Mónica',
    'Verónica', 'Yolanda', 'Miriam', 'Lorena',
  ],
  en: [
    'James', 'John', 'Robert', 'Michael', 'William', 'Richard', 'Joseph',
    'Charles', 'Christopher', 'Matthew', 'Anthony', 'Andrew',
    'Joshua', 'Ryan', 'Nicholas', 'Jonathan', 'Samuel', 'Benjamin', 'Nathan',
    'Adam', 'Peter', 'Simon', 'Oliver', 'Harry', 'George', 'Henry', 'Kevin',
    'Brian', 'Steven', 'Alan', 'Gary', 'Edward', 'Jacob', 'Ethan', 'Liam',
    'Emily', 'Sarah', 'Jessica', 'Jennifer', 'Elizabeth', 'Rachel', 'Rebecca',
    'Megan', 'Hannah', 'Olivia', 'Sophie', 'Charlotte', 'Amelia', 'Isabella',
    'Katherine', 'Alice', 'Chloe', 'Emma', 'Amy', 'Anna',
    'Karen', 'Nicole', 'Michelle', 'Laura',
  ],
  fr: [
    'Michel', 'Philippe', 'Alain', 'Nicolas', 'Christophe',
    'Laurent', 'Julien', 'Antoine', 'Mathieu', 'Guillaume', 'Étienne', 'Rémi',
    'Florian', 'Damien', 'Sébastien', 'Hugo', 'Lucas', 'Louis', 'Théo',
    'Baptiste', 'Vincent', 'Gérard', 'Bernard', 'Didier',
    'Sophie', 'Céline', 'Nathalie', 'Isabelle', 'Sylvie', 'Catherine',
    'Christine', 'Aurélie', 'Émilie', 'Manon', 'Chloé', 'Juliette',
    'Camille', 'Élodie', 'Sandrine', 'Delphine', 'Amandine',
  ],
  de: [
    'Hans', 'Peter', 'Michael', 'Andreas', 'Stefan', 'Klaus',
    'Jürgen', 'Matthias', 'Sebastian', 'Christian', 'Martin', 'Markus',
    'Wolfgang', 'Dieter', 'Bernd', 'Uwe', 'Jonas', 'Lukas', 'Felix',
    'Moritz', 'Tobias', 'Florian', 'Johannes',
    'Anna', 'Julia', 'Katharina', 'Sabine', 'Petra', 'Monika', 'Ursula',
    'Claudia', 'Nicole', 'Andrea', 'Stefanie', 'Christine', 'Lena', 'Hannah',
    'Emma', 'Sophie', 'Franziska', 'Angelika',
  ],
  it: [
    'Giuseppe', 'Giovanni', 'Antonio', 'Mario', 'Luigi', 'Francesco',
    'Alessandro', 'Andrea', 'Matteo', 'Lorenzo', 'Davide', 'Simone',
    'Federico', 'Riccardo', 'Roberto', 'Stefano', 'Paolo', 'Fabio', 'Luca',
    'Nicola', 'Emanuele', 'Domenico', 'Pietro',
    'Giulia', 'Francesca', 'Sara', 'Martina', 'Elisa', 'Valentina', 'Alessia',
    'Silvia', 'Elena', 'Paola', 'Anna', 'Giovanna', 'Federica', 'Ilaria',
    'Beatrice', 'Michela',
  ],
  pt: [
    'João', 'Pedro', 'Tiago', 'Rui', 'Miguel', 'Nuno', 'Ricardo', 'Bruno',
    'Diogo', 'André', 'Gonçalo', 'Rafael', 'Vasco', 'Duarte',
    'Afonso', 'Guilherme', 'Francisco', 'Luís', 'Fábio', 'Hélder',
    'Ana', 'Maria', 'Inês', 'Beatriz', 'Catarina', 'Mariana', 'Joana', 'Rita',
    'Sofia', 'Carolina', 'Matilde', 'Leonor', 'Marta', 'Teresa', 'Cláudia',
    'Filipa', 'Raquel',
  ],
} satisfies Readonly<Record<string, readonly string[]>>;

/** The same table, keyed for lookup by a language code that may not be in it. */
const COMMON_NAMES_BY_LANG = new Map<string, readonly string[]>(Object.entries(COMMON_NAMES));

/** The generic names in play for a pair. Kept separate from the people in the
 *  conversation, whose spelling outranks these — see buildNameIndex. */
export function commonNamesFor(langs: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const lang of langs) {
    const common = COMMON_NAMES_BY_LANG.get(lang);
    if (common) out.push(...common);
  }
  return out;
}

/** Parse the Settings text field: commas or newlines, blanks dropped. */
export function parsePeople(raw: string): readonly string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Render the list back into the Settings text field. */
export function formatPeople(people: readonly string[]): string {
  return people.join(', ');
}
