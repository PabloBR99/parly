// Lazy singleton wiring for the v4 pipeline. Created on first access,
// reused across the app lifetime. The orchestrator reads the API key +
// translation model from settings every turn via configure().

import { ConversationOrchestrator } from './ConversationOrchestrator';
import { audioCaptureService } from '../audio/AudioCaptureService';
import { mistralTranslator } from '../translation/MistralTranslator';
import { nativeTTSService } from '../tts/NativeTTSService';
import { VoxtralRealtimeClient } from '../stt/VoxtralRealtimeClient';

let instance: ConversationOrchestrator | null = null;

export function getOrchestrator(): ConversationOrchestrator {
  if (!instance) {
    instance = new ConversationOrchestrator({
      audioCapture: audioCaptureService,
      voxtral: new VoxtralRealtimeClient(),
      translator: mistralTranslator,
      tts: nativeTTSService,
    });
  }
  return instance;
}
