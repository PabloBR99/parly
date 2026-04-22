// OfflineSttAdapter — SttAdapter backed by the on-device Whisper engine.
//
// Pure pass-through: no extra logic, no error mapping. Existing tests that mock
// WhisperService at the module boundary keep working unchanged.

import { whisperService } from './WhisperService';
import type { SttAdapter } from './SttAdapter';
import type { TranscriptionResult } from '../../app/types';

class OfflineSttAdapter implements SttAdapter {
  readonly name = 'offline' as const;

  transcribe(audioPath: string, language?: string): Promise<TranscriptionResult> {
    return whisperService.transcribe(audioPath, language);
  }
}

export const offlineSttAdapter: SttAdapter = new OfflineSttAdapter();
