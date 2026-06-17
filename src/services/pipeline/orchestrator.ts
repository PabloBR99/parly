// Lazy singleton wiring for the v4 pipeline. Created on first access,
// reused across the app lifetime. The orchestrator reads the API key +
// translation model from settings every turn via configure().

import { ConversationOrchestrator } from './ConversationOrchestrator';
import { audioCaptureService } from '../audio/AudioCaptureService';
import { mistralTranslator } from '../translation/MistralTranslator';
import { nativeTTSService } from '../tts/NativeTTSService';
import { VoxtralRealtimeClient } from '../stt/VoxtralRealtimeClient';
import { SileroVadService } from '../vad/SileroVadService';
import { HANDS_FREE_ENABLED } from '../../app/featureFlags';

// Silence the VAD must observe after speech before firing speech_end (ms).
// This is the single biggest controllable latency in hands-free: it is dead
// air on the front of EVERY response. Silero's library default is 800 ms; 600
// is a well-established "responsive but safe" endpoint that shaves 200 ms off
// each turn with negligible mid-utterance fragmentation. Lower → snappier but
// risks splitting on natural pauses; raise toward 800 if utterances fragment.
const HF_SILENCE_HANGOVER_MS = 600;

let instance: ConversationOrchestrator | null = null;

export function getOrchestrator(): ConversationOrchestrator {
  if (!instance) {
    instance = new ConversationOrchestrator({
      audioCapture: audioCaptureService,
      voxtral: new VoxtralRealtimeClient(),
      translator: mistralTranslator,
      tts: nativeTTSService,
      vad: HANDS_FREE_ENABLED
        ? new SileroVadService({ silenceHangoverMs: HF_SILENCE_HANGOVER_MS })
        : undefined,
    });
  }
  return instance;
}
