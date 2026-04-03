// VADController — glue between AudioCaptureService, VADService, and PipelineOrchestrator.
// Manages continuous listening, speech segment extraction, and anti-echo.

import RNFS from 'react-native-fs';
import { audioCaptureService } from './AudioCaptureService';
import { vadService } from './VADService';
import { writePcmToWav } from './WavWriter';
import { pipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { useConversationStore } from '../../store/conversationStore';

let segmentCounter = 0;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeVad: (() => void) | null = null;
let active = false;

function nextSegmentPath(): string {
  return `${RNFS.DocumentDirectoryPath}/vad_segment_${++segmentCounter}.wav`;
}

export function startVADMode(): void {
  if (active) return;
  active = true;

  vadService.start();

  // Anti-echo: pause VAD while TTS is producing audio
  unsubscribeStore = useConversationStore.subscribe((state, prevState) => {
    if (state.pipelineStage === prevState.pipelineStage) return;

    const stage = state.pipelineStage;
    if (stage === 'synthesizing' || stage === 'playing') {
      vadService.pause();
    } else if (stage === 'idle') {
      vadService.resume();
      // Restore 'listening' indicator while VAD is active
      if (active) {
        useConversationStore.getState().setPipelineStage('listening');
      }
    }
  });

  // Handle completed speech segments
  unsubscribeVad = vadService.onEvent(event => {
    if (event === 'speech_end') {
      const chunks = vadService.collectSpeechChunks();
      if (chunks.length === 0) return;

      const path = nextSegmentPath();
      void (async () => {
        try {
          await writePcmToWav(chunks, path);
          pipelineOrchestrator.submitAuto(path);
        } catch (e) {
          console.error('[VADController] Failed to process segment:', e);
        }
      })();
    }
  });

  // Start continuous audio streaming → VAD
  audioCaptureService.startStreaming(base64Pcm => {
    vadService.processChunk(base64Pcm);
  });

  useConversationStore.getState().setPipelineStage('listening');
}

export function stopVADMode(): void {
  if (!active) return;
  active = false;

  void audioCaptureService.stopStreaming();
  vadService.stop();

  unsubscribeStore?.();
  unsubscribeVad?.();
  unsubscribeStore = null;
  unsubscribeVad = null;

  useConversationStore.getState().setPipelineStage('idle');
}

export function isVADActive(): boolean {
  return active;
}
