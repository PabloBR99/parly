// SttAdapter — common contract for STT backends (offline Whisper, online Voxtral, …).
//
// The orchestrator stays agnostic of *which* backend is transcribing; the resolver
// picks one based on user preference and network state (see SttAdapterResolver).
// Every adapter returns the same TranscriptionResult shape so downstream LID,
// translation, and TTS work without branching.

import type { TranscriptionResult } from '../../app/types';

export type SttAdapterName = 'offline' | 'online';

export interface SttAdapter {
  readonly name: SttAdapterName;
  /**
   * Transcribe audio at the given path.
   * language is an optional hint — adapters may ignore it (Whisper auto-detects,
   * Voxtral will accept it as a decoder prompt when available).
   */
  transcribe(audioPath: string, language?: string): Promise<TranscriptionResult>;
}
