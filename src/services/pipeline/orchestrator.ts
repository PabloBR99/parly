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
// Dead air on the front of EVERY response, so it is the single biggest
// controllable latency in hands-free — but it cannot simply be cut: it is
// also the only thing stopping a mid-sentence breath from splitting an
// utterance in two, and the second half of a split utterance is lost (the mic
// is gated while the phone reads the first half back). Silero's library
// default is 800 ms; 600 is the established "responsive but safe" endpoint.
const HF_SILENCE_HANGOVER_MS = 600;
// Silence after which the VAD asks whether the turn might be over (ms). The
// orchestrator answers with evidence the VAD does not have — whether the
// transcript just closed a sentence — and ends the turn early when it did.
// Utterances that pause mid-clause ignore the hint and still get the full
// hangover, so this buys latency on the common case without trading away the
// protection above.
//
// This is a floor, not the decision point: the hint only arms a check that
// fires when the transcript stops growing, which cannot happen before Voxtral
// has delivered the words (TARGET_STREAMING_DELAY_MS after they were spoken).
// Set below that delivery time so it never becomes the binding constraint —
// the transcript arriving should be what ends the turn, not this timer. A
// speaker who resumes cancels everything the hint started.
// Must stay below HF_SILENCE_HANGOVER_MS.
const HF_PAUSE_HINT_MS = 280;

let instance: ConversationOrchestrator | null = null;

export function getOrchestrator(): ConversationOrchestrator {
  if (!instance) {
    instance = new ConversationOrchestrator({
      audioCapture: audioCaptureService,
      voxtral: new VoxtralRealtimeClient(),
      translator: mistralTranslator,
      tts: nativeTTSService,
      vad: HANDS_FREE_ENABLED
        ? new SileroVadService({
            silenceHangoverMs: HF_SILENCE_HANGOVER_MS,
            pauseHintMs: HF_PAUSE_HINT_MS,
          })
        : undefined,
    });
  }
  return instance;
}
