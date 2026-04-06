export type PersonId = 'person_a' | 'person_b';
export type VoiceId = 'casual_male' | 'casual_female';
export type PipelineStage =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'streaming'
  | 'transcribing'
  | 'translating'
  | 'synthesizing'
  | 'playing';
export type ModelStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'error';

export interface PersonConfig {
  readonly language: string; // BCP-47, e.g. "es", "en", "de"
  readonly voice: VoiceId;
  readonly displayName: string;
}

export interface Message {
  readonly id: string;
  readonly speakerId: PersonId;
  readonly originalText: string;
  readonly translatedText: string | null;
  readonly stage: 'transcribing' | 'translating' | 'done' | 'error';
  readonly timestamp: number;
}

export interface Utterance {
  readonly id: string;
  readonly speakerId: PersonId;
  readonly audioPath: string; // path to recorded WAV file
  readonly sourceLang: string;
  readonly targetLang: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language: string;
}

export interface TranslationResult {
  readonly text: string;
}

export interface Language {
  readonly code: string; // BCP-47
  readonly name: string;
  readonly flag: string; // emoji
}
