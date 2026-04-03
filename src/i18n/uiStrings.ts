export interface UiStrings {
  readonly holdToSpeak: string;
  readonly listening: string;
  readonly recording: string;
  readonly transcribing: string;
  readonly translating: string;
  readonly synthesizing: string;
  readonly playing: string;
  readonly searchLanguage: string;
  readonly cancel: string;
}

const strings: Record<string, UiStrings> = {
  en: {
    holdToSpeak:    'Hold to speak',
    listening:      'Listening…',
    recording:      'Recording…',
    transcribing:   'Transcribing…',
    translating:    'Translating…',
    synthesizing:   'Synthesizing…',
    playing:        'Playing…',
    searchLanguage: 'Search language…',
    cancel:         'Cancel',
  },
  es: {
    holdToSpeak:    'Mantén para hablar',
    listening:      'Escuchando…',
    recording:      'Grabando…',
    transcribing:   'Transcribiendo…',
    translating:    'Traduciendo…',
    synthesizing:   'Sintetizando…',
    playing:        'Reproduciendo…',
    searchLanguage: 'Buscar idioma…',
    cancel:         'Cancelar',
  },
  fr: {
    holdToSpeak:    'Maintenir pour parler',
    listening:      'Écoute…',
    recording:      'Enregistrement…',
    transcribing:   'Transcription…',
    translating:    'Traduction…',
    synthesizing:   'Synthèse…',
    playing:        'Lecture…',
    searchLanguage: 'Rechercher une langue…',
    cancel:         'Annuler',
  },
  de: {
    holdToSpeak:    'Halten zum Sprechen',
    listening:      'Zuhören…',
    recording:      'Aufnahme…',
    transcribing:   'Transkription…',
    translating:    'Übersetzung…',
    synthesizing:   'Synthese…',
    playing:        'Wiedergabe…',
    searchLanguage: 'Sprache suchen…',
    cancel:         'Abbrechen',
  },
  it: {
    holdToSpeak:    'Tieni premuto per parlare',
    listening:      'Ascolto…',
    recording:      'Registrazione…',
    transcribing:   'Trascrizione…',
    translating:    'Traduzione…',
    synthesizing:   'Sintesi…',
    playing:        'Riproduzione…',
    searchLanguage: 'Cerca lingua…',
    cancel:         'Annulla',
  },
  pt: {
    holdToSpeak:    'Segure para falar',
    listening:      'Ouvindo…',
    recording:      'Gravando…',
    transcribing:   'Transcrevendo…',
    translating:    'Traduzindo…',
    synthesizing:   'Sintetizando…',
    playing:        'Reproduzindo…',
    searchLanguage: 'Pesquisar idioma…',
    cancel:         'Cancelar',
  },
  nl: {
    holdToSpeak:    'Ingedrukt houden om te spreken',
    listening:      'Luisteren…',
    recording:      'Opnemen…',
    transcribing:   'Transcriberen…',
    translating:    'Vertalen…',
    synthesizing:   'Synthetiseren…',
    playing:        'Afspelen…',
    searchLanguage: 'Taal zoeken…',
    cancel:         'Annuleren',
  },
  ar: {
    holdToSpeak:    'اضغط مطولاً للتحدث',
    listening:      'جارٍ الاستماع…',
    recording:      'جارٍ التسجيل…',
    transcribing:   'جارٍ النسخ…',
    translating:    'جارٍ الترجمة…',
    synthesizing:   'جارٍ التوليف…',
    playing:        'جارٍ التشغيل…',
    searchLanguage: 'البحث عن لغة…',
    cancel:         'إلغاء',
  },
  hi: {
    holdToSpeak:    'बोलने के लिए दबाए रखें',
    listening:      'सुन रहा है…',
    recording:      'रिकॉर्डिंग…',
    transcribing:   'लिप्यंतरण…',
    translating:    'अनुवाद…',
    synthesizing:   'संश्लेषण…',
    playing:        'चला रहा है…',
    searchLanguage: 'भाषा खोजें…',
    cancel:         'रद्द करें',
  },
};

export function getUiStrings(langCode: string): UiStrings {
  const base = langCode.split('-')[0].toLowerCase();
  return strings[base] ?? strings.en;
}
