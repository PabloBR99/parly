// Singleton wiring for the v4 pipeline. Created once, reused across the
// app lifetime. The orchestrator instance reads the API key + translation
// model from settings every turn via configure(), so re-rendering doesn't
// have to recreate it.

import { ConversationOrchestrator } from './ConversationOrchestrator';
import { audioCaptureService } from '../audio/AudioCaptureService';
import { mistralTranslator } from '../translation/MistralTranslator';
import { nativeTTSService } from '../tts/NativeTTSService';
import { VoxtralRealtimeClient } from '../stt/VoxtralRealtimeClient';

// One Voxtral client instance — its state machine resets on each end()/start()
// cycle so it serves an unlimited number of sequential turns.
const voxtralClient = new VoxtralRealtimeClient();

export const conversationOrchestrator = new ConversationOrchestrator({
  audioCapture: audioCaptureService,
  voxtral: voxtralClient,
  translator: mistralTranslator,
  tts: nativeTTSService,
});
