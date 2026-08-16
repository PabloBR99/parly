// textLangId — decides which of the TWO configured pair languages a
// transcript is written in, from the text alone.
//
// Why this exists: hands-free routing originally trusted Voxtral's
// `transcription.language` audio tag exclusively. That tag sometimes misfires
// (Spanish tagged as English, Catalan for Spanish) or is simply absent — and
// a wrong tag inverts the translation direction, so the app "translates"
// Spanish into Spanish and parrots the speaker. The transcript itself is the
// strongest evidence available: it IS the text about to be translated, so its
// language decides which direction produces a real translation.
//
// This is deliberately NOT open-set language identification. The pair is
// known, so the problem collapses to a binary choice, which two cheap signals
// solve almost entirely:
//
//   1. Script. Most pairs differ in writing system (Latin vs Cyrillic vs
//      Arabic vs Han vs …) — character ranges decide instantly.
//   2. Lexicon. Same-script pairs (es↔en, ru↔uk, ar↔fa…) are scored with
//      small per-language profiles: high-frequency spoken function words and
//      distinctive characters (¿ñ for Spanish, ß for German, іїєґ for
//      Ukrainian, پچژگ for Persian…).
//
// Words shared between the two pair languages score for BOTH sides, so they
// cancel in the margin; only the difference decides. The classifier abstains
// (null) rather than guess — abstaining falls back to the audio tag, and only
// then to speaker alternation, which is exactly the old behavior.

export type PairSide = 'a' | 'b';

export interface PairTextVote {
  readonly side: PairSide;
  /** 'strong' evidence may OVERRIDE a contradicting audio tag; 'weak'
   *  evidence is only used when the audio tag abstained or is out-of-pair. */
  readonly strength: 'strong' | 'weak';
}

// ── Script detection ─────────────────────────────────────────────────────────

type Script =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'devanagari'
  | 'bengali'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'thai';

function scriptOf(cp: number): Script | null {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  if (cp >= 0xc0 && cp <= 0x24f) return 'latin';   // Latin-1 Sup + Extended A/B
  if (cp >= 0x1e00 && cp <= 0x1eff) return 'latin'; // Latin Ext. Additional (vi)
  if (cp >= 0x400 && cp <= 0x4ff) return 'cyrillic';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f)) return 'arabic';
  if (cp >= 0x590 && cp <= 0x5ff) return 'hebrew';
  if (cp >= 0x900 && cp <= 0x97f) return 'devanagari';
  if (cp >= 0x980 && cp <= 0x9ff) return 'bengali';
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return 'han';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return 'hangul';
  if (cp >= 0xe00 && cp <= 0xe7f) return 'thai';
  return null;
}

/** Writing system(s) per language. Anything not listed writes in Latin. */
const LANG_SCRIPTS = new Map<string, readonly Script[]>(Object.entries({
  ru: ['cyrillic'],
  uk: ['cyrillic'],
  el: ['greek'],
  ar: ['arabic'],
  fa: ['arabic'],
  ur: ['arabic'],
  he: ['hebrew'],
  hi: ['devanagari'],
  bn: ['bengali'],
  zh: ['han'],
  ja: ['han', 'kana'],
  ko: ['hangul'],
  th: ['thai'],
}));

function scriptsFor(lang: string): readonly Script[] {
  return LANG_SCRIPTS.get(lang) ?? ['latin'];
}

/**
 * Enough scripted characters to have an opinion. Below this a transcript is
 * "Oui.", "42", "OK" — true answers whose writing system says nothing, and
 * rejecting them would be worse than the problem being solved.
 */
const MIN_SCRIPTED_CHARS = 4;

/**
 * Could this transcript be the language the speaker chose?
 *
 * Not language identification — a much smaller question, asked only where the
 * expected language is already known: is this even written in an alphabet that
 * language uses? Push-to-talk knows exactly which language the speaker
 * selected, so a transcript that comes back in Han characters for a French
 * turn is not a bad guess to be translated anyway. It is the transcriber
 * having heard something that was not the sentence, and the only honest
 * output is nothing.
 *
 * Deliberately one-sided and deliberately blunt. It answers *no* only for a
 * clear script mismatch and abstains (true) everywhere else, because the cost
 * of the two mistakes is nowhere near symmetric: a wrong rejection loses a
 * sentence the speaker has to repeat, while a wrong acceptance sends the
 * translator text in a language it was not told about and speaks the result
 * aloud to someone who then has to work out what happened.
 *
 * What it therefore does NOT catch: French returned as Spanish, or any other
 * confusion inside one writing system. That needs the lexical machinery below,
 * which is built for choosing between two known languages and is not reliable
 * enough one-sided — most short utterances score nothing at all, and a
 * classifier that abstains on "Bonjour" would reject half of what anybody
 * says. Script is the part that can be decided from a single character, and it
 * is the part the flagrant failures live in.
 *
 * `lang` must be a primary subtag ("fr", not "fr-CA").
 */
export function writtenInScriptOf(text: string, lang: string): boolean {
  const expected = scriptsFor(lang);
  let total = 0;
  let matching = 0;
  for (const ch of text.normalize('NFC')) {
    const s = scriptOf(ch.codePointAt(0) ?? 0);
    // Digits, punctuation and emoji belong to no writing system and are
    // evidence for nobody — they are simply not counted on either side.
    if (s === null) continue;
    total++;
    if (expected.includes(s)) matching++;
  }
  if (total < MIN_SCRIPTED_CHARS) return true;
  // A simple majority, because the realistic mixed case is a correct
  // transcript carrying a foreign name or a unit ("Bonjour, je suis à Tokyo
  // 東京"), and the failure case is not mixed at all — it is a whole sentence
  // in the wrong script.
  return matching * 2 >= total;
}

// ── Lexical profiles ─────────────────────────────────────────────────────────
//
// Curation rules:
//   - Spoken-register function words + greetings; this is a conversation app.
//   - A word shared by two languages appears in BOTH lists so it cancels in
//     the margin instead of biasing one side ("es" is Spanish is and German
//     it; "ja" is yes in German/Dutch/Scandinavian and I in Polish; "on" is
//     English/French/Finnish...).
//   - Globally ambiguous one-offs ("no", "a", "o", "me", "se", "si") are in
//     no list at all.
//   - Only same-script pairs ever compare lexically, so collisions across
//     scripts (Hungarian "az" vs Persian "az") are irrelevant.

const STOPWORDS = new Map<string, readonly string[]>(Object.entries({
  en: [
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'the', 'an', 'is', 'are',
    'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', "don't", 'not',
    'what', 'how', 'where', 'when', 'who', 'why', 'this', 'that', 'these',
    'with', 'for', 'and', 'or', 'but', 'my', 'your', 'of', 'to', 'in', 'on',
    'at', 'have', 'has', 'had', 'can', 'will', 'would', 'could', 'should',
    'yes', 'yeah', 'okay', 'hello', 'hi', 'thanks', 'thank', 'please',
    'good', 'well', 'right', 'want', 'need', 'know', 'think', 'see', 'go',
    // Ordinary function words whose absence made ordinary sentences abstain:
    // "I'm from Madrid" scored zero and got routed by blind alternation, so
    // English was handed to the translator as Spanish and came back unchanged.
    // Checked against every other profile in this file for collisions; words
    // that also exist in another pair language (a, me, no, so, us, back) stay
    // out, because a tie is worse than a gap.
    'from', 'about', 'there', 'here', 'them', 'him', 'because', 'if', 'just',
    'very', 'than', 'then', 'after', 'before', 'always', 'never', 'again',
    'only', 'much', 'many', 'get', 'make', 'take', 'say', 'look', 'like',
    'little', 'something', 'really',
  ],
  es: [
    'yo', 'usted', 'ustedes', 'ella', 'ellos', 'nosotros', 'el', 'él', 'la',
    'los', 'las', 'un', 'una', 'unos', 'unas', 'es', 'está', 'están',
    'estás', 'estoy', 'son', 'soy', 'hay', 'sí', 'qué', 'cómo', 'cuándo',
    'cuánto', 'dónde', 'quién', 'por', 'porque', 'para', 'con', 'sin', 'del',
    'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'aquí', 'mi', 'tengo',
    'tienes', 'tiene', 'quiero', 'quieres', 'puedo', 'puedes', 'puede',
    'hola', 'gracias', 'buenos', 'buenas', 'días', 'tardes', 'noches',
    'bien', 'muy', 'mucho', 'más', 'pero', 'también', 'vale', 'claro',
    'bueno', 'entonces', 'pues', 'ahora', 'hoy', 'y', 'que', 'de', 'en',
  ],
  fr: [
    'je', 'tu', 'vous', 'il', 'elle', 'nous', 'ils', 'elles', 'le', 'la',
    'les', 'un', 'une', 'des', 'du', 'est', 'sont', 'suis', 'êtes', 'et',
    'où', 'que', 'qui', 'quoi', 'comment', 'pourquoi', 'quand', 'combien',
    'avec', 'pour', 'dans', 'sur', 'ce', 'cette', 'ça', 'ne', 'pas', 'mon',
    'ma', 'mes', 'votre', 'vos', 'oui', 'non', 'bonjour', 'bonsoir',
    'merci', "c'est", "s'il", 'très', 'bien', 'aussi', 'voudrais', 'veux',
    'peux', 'alors', 'voilà', 'de', 'en', 'on', 'maintenant', "aujourd'hui",
  ],
  de: [
    'ich', 'du', 'sie', 'er', 'es', 'wir', 'ihr', 'der', 'die', 'das',
    'ein', 'eine', 'einen', 'einem', 'ist', 'sind', 'bin', 'bist', 'war',
    'waren', 'nicht', 'kein', 'keine', 'was', 'wie', 'wo', 'wer', 'warum',
    'wann', 'mit', 'für', 'auf', 'aus', 'zu', 'von', 'nach', 'und', 'oder',
    'aber', 'mein', 'meine', 'dein', 'ihre', 'ja', 'nein', 'hallo', 'guten',
    'morgen', 'tag', 'abend', 'danke', 'bitte', 'sehr', 'gut', 'auch',
    'möchte', 'kann', 'können', 'haben', 'habe', 'hat', 'jetzt', 'heute',
  ],
  it: [
    'io', 'tu', 'lei', 'noi', 'voi', 'loro', 'il', 'lo', 'la', 'gli', 'le',
    'un', 'uno', 'una', 'è', 'sono', 'sei', 'siamo', 'siete', 'e', 'che',
    'chi', 'cosa', 'come', 'dove', 'perché', 'quando', 'quanto', 'con',
    'per', 'di', 'da', 'del', 'della', 'questo', 'questa', 'quello',
    'quella', 'qui', 'mio', 'mia', 'tuo', 'suo', 'non', 'sì', 'ciao',
    'buongiorno', 'buonasera', 'grazie', 'prego', 'molto', 'bene', 'anche',
    'voglio', 'posso', 'può', 'puoi', 'allora', 'certo', 'adesso', 'oggi',
    'i', 'in',
  ],
  pt: [
    'eu', 'você', 'vocês', 'ele', 'ela', 'nós', 'eles', 'elas', 'os', 'as',
    'um', 'uma', 'umas', 'é', 'são', 'sou', 'está', 'estou', 'estão', 'e',
    'que', 'quem', 'como', 'onde', 'porque', 'quando', 'quanto', 'com',
    'para', 'em', 'de', 'do', 'da', 'dos', 'das', 'na', 'nas', 'isto',
    'isso', 'aquilo', 'meu', 'minha', 'seu', 'sua', 'sim', 'não', 'olá',
    'oi', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada',
    'muito', 'bem', 'também', 'quero', 'posso', 'pode', 'então', 'agora',
    'hoje', 'já', 'tá',
  ],
  nl: [
    'ik', 'jij', 'je', 'u', 'hij', 'zij', 'ze', 'wij', 'we', 'het', 'een',
    'en', 'is', 'zijn', 'ben', 'bent', 'was', 'niet', 'geen', 'wat', 'hoe',
    'waar', 'wie', 'waarom', 'wanneer', 'met', 'voor', 'naar', 'uit', 'van',
    'over', 'dit', 'dat', 'deze', 'mijn', 'jouw', 'uw', 'ja', 'nee',
    'hallo', 'hoi', 'dank', 'bedankt', 'alstublieft', 'goed', 'ook', 'wil',
    'kan', 'kunnen', 'hebben', 'heb', 'heeft', 'nu', 'vandaag', 'de',
  ],
  pl: [
    'to', 'jest', 'są', 'jestem', 'jesteś', 'ja', 'ty', 'my', 'wy', 'on',
    'ona', 'ono', 'oni', 'lub', 'albo', 'czy', 'co', 'jak', 'gdzie', 'kto',
    'dlaczego', 'kiedy', 'ile', 'z', 'dla', 'na', 'w', 'przy', 'mam',
    'masz', 'ma', 'chcę', 'chce', 'mogę', 'może', 'dziękuję', 'proszę',
    'dobrze', 'cześć', 'dzień', 'dobry', 'bardzo', 'też', 'tak', 'teraz',
    'dzisiaj', 'i', 'do', 'nie', 'się',
  ],
  cs: [
    'to', 'je', 'jsou', 'jsem', 'jsi', 'jste', 'já', 'ty', 'vy', 'my',
    'nebo', 'ano', 'co', 'jak', 'kde', 'kdo', 'proč', 'kdy', 'kolik', 's',
    'pro', 'na', 'v', 've', 'mám', 'máš', 'má', 'chci', 'můžu', 'mohu',
    'děkuji', 'prosím', 'dobře', 'ahoj', 'dobrý', 'den', 'velmi', 'také',
    'tak', 'teď', 'dnes', 'do', 'ne',
  ],
  tr: [
    'bir', 'bu', 'şu', 've', 'veya', 'ama', 'değil', 'evet', 'hayır', 'ne',
    'nasıl', 'nerede', 'neden', 'kim', 'kaç', 'ile', 'için', 'var', 'yok',
    'ben', 'sen', 'biz', 'siz', 'çok', 'iyi', 'merhaba', 'günaydın',
    'teşekkür', 'teşekkürler', 'lütfen', 'ederim', 'şimdi', 'bugün', 'mı',
    'mi', 'mu', 'mü', 'musunuz', 'misiniz',
  ],
  vi: [
    'là', 'và', 'không', 'có', 'gì', 'sao', 'đâu', 'với', 'cho', 'của',
    'tôi', 'bạn', 'anh', 'chị', 'em', 'ông', 'bà', 'xin', 'chào', 'cảm',
    'ơn', 'rất', 'tốt', 'này', 'đó', 'được', 'một', 'hai', 'vâng', 'dạ',
    'bây', 'giờ', 'hôm', 'nay',
  ],
  id: [
    'ini', 'itu', 'dan', 'atau', 'tidak', 'ya', 'apa', 'siapa',
    'bagaimana', 'mana', 'dimana', 'kenapa', 'dengan', 'untuk', 'dari',
    'saya', 'kamu', 'anda', 'kami', 'kita', 'dia', 'ada', 'yang', 'sudah',
    'belum', 'bisa', 'mau', 'terima', 'kasih', 'selamat', 'pagi', 'siang',
    'malam', 'baik', 'halo', 'sekarang', 'hari',
  ],
  sv: [
    'det', 'den', 'en', 'ett', 'är', 'jag', 'du', 'ni', 'vi', 'han', 'hon',
    'och', 'eller', 'men', 'inte', 'vad', 'hur', 'var', 'vem', 'varför',
    'när', 'med', 'för', 'till', 'från', 'har', 'hade', 'ska', 'kan',
    'vill', 'tack', 'snälla', 'bra', 'hej', 'ja', 'nej', 'mycket', 'också',
    'nu', 'idag', 'att', 'som',
  ],
  no: [
    'det', 'den', 'en', 'et', 'ei', 'er', 'jeg', 'du', 'dere', 'vi', 'han',
    'hun', 'og', 'eller', 'men', 'ikke', 'hva', 'hvordan', 'hvor', 'hvem',
    'hvorfor', 'når', 'med', 'for', 'til', 'fra', 'har', 'hadde', 'skal',
    'kan', 'vil', 'takk', 'bra', 'hei', 'ja', 'nei', 'veldig', 'også',
    'nå', 'å', 'som', 'der',
  ],
  da: [
    'det', 'den', 'en', 'et', 'er', 'jeg', 'du', 'i', 'vi', 'han', 'hun',
    'og', 'eller', 'men', 'ikke', 'hvad', 'hvordan', 'hvor', 'hvem',
    'hvorfor', 'hvornår', 'med', 'for', 'til', 'fra', 'har', 'havde',
    'skal', 'kan', 'vil', 'tak', 'godt', 'hej', 'ja', 'nej', 'meget',
    'også', 'nu', 'at', 'som', 'der',
  ],
  fi: [
    'minä', 'sinä', 'hän', 'te', 'he', 'ja', 'tai', 'mutta', 'ei', 'kyllä',
    'joo', 'mitä', 'miten', 'missä', 'kuka', 'miksi', 'milloin', 'kanssa',
    'olen', 'olet', 'on', 'ole', 'kiitos', 'hyvä', 'hyvää', 'hei', 'moi',
    'erittäin', 'myös', 'nyt', 'tänään', 'tämä', 'tuo', 'päivää',
  ],
  ro: [
    'este', 'sunt', 'ești', 'eu', 'tu', 'el', 'ea', 'noi', 'voi', 'ei',
    'ele', 'și', 'sau', 'dar', 'nu', 'da', 'ce', 'cum', 'unde', 'cine',
    'când', 'cât', 'cu', 'pentru', 'la', 'din', 'pe', 'un', 'am', 'ai',
    'are', 'avem', 'vreau', 'pot', 'poate', 'mulțumesc', 'mersi', 'vă',
    'rog', 'bine', 'bună', 'ziua', 'salut', 'foarte', 'acum', 'azi',
  ],
  hu: [
    'ez', 'az', 'egy', 'van', 'vannak', 'vagyok', 'vagy', 'és', 'nem',
    'igen', 'mit', 'mi', 'hogyan', 'hol', 'ki', 'miért', 'mikor', 'mennyi',
    'hogy', 'de', 'én', 'te', 'ön', 'jó', 'jól', 'nagyon', 'köszönöm',
    'köszi', 'kérem', 'szia', 'helló', 'most', 'ma', 'itt', 'ott', 'is',
  ],
  sw: [
    'ni', 'na', 'au', 'lakini', 'ndiyo', 'ndio', 'hapana', 'nini', 'vipi',
    'wapi', 'nani', 'lini', 'kwa', 'ya', 'wa', 'za', 'mimi', 'wewe',
    'yeye', 'sisi', 'ninyi', 'wao', 'asante', 'sana', 'habari', 'nzuri',
    'jambo', 'karibu', 'sawa', 'iko', 'yuko', 'hii', 'hiyo', 'sasa', 'leo',
    'je',
  ],
  ru: [
    'я', 'ты', 'вы', 'мы', 'он', 'она', 'они', 'оно', 'это', 'этот',
    'что', 'как', 'где', 'кто', 'почему', 'когда', 'сколько', 'и', 'или',
    'но', 'не', 'нет', 'да', 'с', 'для', 'на', 'в', 'у', 'к', 'есть',
    'был', 'была', 'было', 'хочу', 'могу', 'можно', 'спасибо',
    'пожалуйста', 'привет', 'здравствуйте', 'хорошо', 'очень', 'тоже',
    'сейчас', 'сегодня',
  ],
  uk: [
    'я', 'ти', 'ви', 'ми', 'він', 'вона', 'вони', 'воно', 'це', 'цей',
    'що', 'як', 'де', 'хто', 'чому', 'коли', 'скільки', 'і', 'або', 'але',
    'не', 'ні', 'так', 'з', 'для', 'на', 'в', 'у', 'до', 'є', 'був',
    'була', 'було', 'хочу', 'можу', 'можна', 'дякую', 'будь', 'ласка',
    'привіт', 'добрий', 'добре', 'дуже', 'теж', 'зараз', 'сьогодні',
  ],
  ar: [
    'في', 'من', 'إلى', 'على', 'عن', 'هذا', 'هذه', 'ذلك', 'ما', 'ماذا',
    'كيف', 'أين', 'لماذا', 'متى', 'كم', 'أنا', 'أنت', 'نحن', 'هو', 'هي',
    'هم', 'لا', 'نعم', 'شكرا', 'شكراً', 'مرحبا', 'مرحباً', 'أهلا', 'صباح',
    'مساء', 'الخير', 'جدا', 'جداً', 'هل', 'الآن', 'اليوم', 'يا',
  ],
  fa: [
    'در', 'از', 'به', 'با', 'برای', 'این', 'آن', 'چه', 'چی', 'چطور',
    'کجا', 'کی', 'چرا', 'چند', 'من', 'تو', 'شما', 'ما', 'او', 'آنها',
    'نه', 'بله', 'آره', 'ممنون', 'متشکرم', 'مرسی', 'سلام', 'خداحافظ',
    'است', 'هست', 'نیست', 'خوب', 'خیلی', 'می', 'الان', 'امروز', 'را',
    'که',
  ],
  ur: [
    'میں', 'سے', 'کو', 'پر', 'کے', 'کی', 'کا', 'یہ', 'وہ', 'کیا', 'کیسے',
    'کہاں', 'کون', 'کیوں', 'کب', 'کتنا', 'آپ', 'ہم', 'تم', 'نہیں', 'ہاں',
    'جی', 'شکریہ', 'سلام', 'ہے', 'ہیں', 'تھا', 'تھی', 'اچھا', 'بہت',
    'اب', 'آج', 'اور',
  ],
}));

/** Characters strongly associated with a language. Shared characters (é in
 *  es/fr/pt) appear in every set that uses them, so they cancel pairwise.
 *  Cyrillic entries are escaped — Latin i and Cyrillic і are homoglyphs. */
const CHARS = new Map<string, string>(Object.entries({
  es: 'ñ¿¡áéíóú',
  fr: 'àâçéèêëîïôùûüœ',
  de: 'äöüß',
  it: 'àèéìòù',
  pt: 'ãõçáâàéêíóôúü',
  pl: 'ąćęłńśźżó',
  cs: 'áčďéěíňóřšťúůýž',
  tr: 'çğıöşü',
  vi:
    'ăâđêôơư' +
    'àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ',
  sv: 'åäö',
  no: 'åæø',
  da: 'åæø',
  fi: 'äö',
  ro: 'ăâîșțşţ',
  hu: 'áéíóöőúüű',
  ru: 'ыэъё',           // ы э ъ ё
  uk: 'іїєґ',           // і ї є ґ
  // Arabic-script trio: ك/ي (U+0643/U+064A) are the Arabic forms; Persian and
  // Urdu write ک/ی (U+06A9/U+06CC) instead — near-perfect discriminators.
  ar: 'كيةء',           // ك ي ة ء
  fa: 'پچژگکی', // پ چ ژ گ ک ی
  ur: 'ٹڈڑںےہھکی', // ٹ ڈ ڑ ں ے ہ ھ ک ی
}));

// Decision thresholds. A stopword hit scores 2, a distinctive char 1.
// 'strong' (may override the audio tag) needs a clear multi-signal win;
// 'weak' (used only when audio abstains) accepts a single confident signal.
const STRONG_MIN = 4;
const STRONG_MARGIN = 3;
const WEAK_MIN = 2;
const WEAK_MARGIN = 2;

function lexScore(lowerText: string, tokens: readonly string[], lang: string): number {
  let score = 0;
  const stopwords = STOPWORDS.get(lang);
  if (stopwords && stopwords.length > 0) {
    const set = new Set(stopwords);
    for (const t of tokens) {
      if (set.has(t)) {
        score += 2;
        continue;
      }
      // Contractions. The tokenizer keeps the apostrophe, so "i'm" is one
      // token and matched neither 'i' nor 'am' — which is how the most
      // ordinary English sentence could score nothing at all. Profiles that
      // list a contraction whole (en "don't", fr "c'est") match above; this
      // catches the rest by their stem.
      const apos = t.indexOf("'");
      if (apos > 0 && set.has(t.slice(0, apos))) score += 2;
    }
  }
  const chars = CHARS.get(lang);
  if (chars) {
    const charSet = new Set(chars);
    for (const ch of lowerText) {
      if (charSet.has(ch)) score += 1;
    }
  }
  return score;
}

/**
 * Whether `token` is a high-frequency function word in any of `langs`.
 *
 * The profiles above exist to route a turn, but they are also the only list in
 * the app of "words an ordinary sentence is made of" — which is exactly what
 * the name repair needs to leave alone. Reusing them means a word that helps
 * decide the language can never simultaneously be read as somebody's name.
 *
 * `langs` are primary subtags; unknown ones contribute nothing.
 */
export function isFunctionWord(token: string, langs: readonly string[]): boolean {
  if (token.length === 0 || langs.length === 0) return false;
  const lower = token.toLowerCase().replace(/’/g, "'");
  for (const lang of langs) {
    const set = functionWordSet(lang);
    if (set === null) continue;
    if (set.has(lower)) return true;
    const apos = lower.indexOf("'");
    if (apos > 0 && set.has(lower.slice(0, apos))) return true;
  }
  return false;
}

const functionWordCache = new Map<string, ReadonlySet<string> | null>();

function functionWordSet(lang: string): ReadonlySet<string> | null {
  const cached = functionWordCache.get(lang);
  if (cached !== undefined) return cached;
  const words = STOPWORDS.get(lang);
  const set = words ? new Set(words) : null;
  functionWordCache.set(lang, set);
  return set;
}

/**
 * Classify a transcript as pair language A or B, or abstain (null).
 * `langA`/`langB` must be primary subtags ("es", not "es-MX").
 */
export function classifyPairText(
  text: string,
  langA: string,
  langB: string,
): PairTextVote | null {
  if (langA === langB) return null;
  const normalized = text.normalize('NFC');

  // 1) Script evidence. Count characters in scripts exclusive to each side.
  const scriptsA = scriptsFor(langA);
  const scriptsB = scriptsFor(langB);
  const counts = new Map<Script, number>();
  for (const ch of normalized) {
    const s = scriptOf(ch.codePointAt(0) ?? 0);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const countIn = (scripts: readonly Script[], excluding: readonly Script[]): number => {
    let n = 0;
    for (const s of scripts) {
      if (!excluding.includes(s)) n += counts.get(s) ?? 0;
    }
    return n;
  };
  const exclA = countIn(scriptsA, scriptsB);
  const exclB = countIn(scriptsB, scriptsA);
  if (exclA >= 2 && exclB === 0) return { side: 'a', strength: 'strong' };
  if (exclB >= 2 && exclA === 0) return { side: 'b', strength: 'strong' };
  if (exclA >= 2 && exclB >= 2) {
    // Mixed-script text (brand names, code-switching): only a heavy majority decides.
    if (exclA >= 3 * exclB) return { side: 'a', strength: 'strong' };
    if (exclB >= 3 * exclA) return { side: 'b', strength: 'strong' };
    return null;
  }

  // zh↔ja share Han. Kana is exclusive to Japanese (handled above); a run of
  // Han with no kana at all reads as Chinese — Japanese without kana is rare.
  if ((langA === 'zh' && langB === 'ja') || (langA === 'ja' && langB === 'zh')) {
    if ((counts.get('han') ?? 0) >= 2 && (counts.get('kana') ?? 0) === 0) {
      return { side: langA === 'zh' ? 'a' : 'b', strength: 'strong' };
    }
    return null;
  }

  // 2) Lexical evidence for same-script pairs. Typographic apostrophes fold
  // to ASCII so "c’est" matches the profile entry "c'est".
  const lower = normalized.toLowerCase().replace(/’/g, "'");
  const tokens = lower.match(/[\p{L}\p{M}']+/gu) ?? [];
  const scoreA = lexScore(lower, tokens, langA);
  const scoreB = lexScore(lower, tokens, langB);
  const best = Math.max(scoreA, scoreB);
  const margin = Math.abs(scoreA - scoreB);
  const side: PairSide = scoreA >= scoreB ? 'a' : 'b';
  if (best >= STRONG_MIN && margin >= STRONG_MARGIN) return { side, strength: 'strong' };
  if (best >= WEAK_MIN && margin >= WEAK_MARGIN) return { side, strength: 'weak' };
  return null;
}
