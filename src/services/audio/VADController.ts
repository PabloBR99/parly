// VADController — glue between AudioCaptureService, VADService, and PipelineOrchestrator.
// Manages continuous listening, speech segment extraction, and anti-echo.
//
// Phase 1 streaming: when the streaming pipeline is available (ACTIVE phase with
// Kroko models loaded), audio chunks are fed to the streaming ASR in real-time
// instead of accumulating a WAV file for offline processing.

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { audioCaptureService } from './AudioCaptureService';
import { vadService } from './VADService';
import { writePcmToWav } from './WavWriter';
import { pipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { streamingPipeline } from '../pipeline/StreamingPipeline';
import { useConversationStore } from '../../store/conversationStore';

let segmentCounter = 0;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeVad: (() => void) | null = null;
let active = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the CURRENT utterance is using streaming. Set on speech_start, read on speech_end. */
let utteranceIsStreaming = false;

// Delay after TTS finishes before resuming VAD — avoids capturing speaker echo tail
const POST_TTS_COOLDOWN_MS = 500;

function nextSegmentPath(): string {
  return `${DocumentDirectoryPath}/vad_segment_${++segmentCounter}.wav`;
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
      // Clear any pending resume timer
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      vadService.pause();
    } else if (stage === 'idle') {
      // Wait a bit after TTS ends to let echo dissipate
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (active) {
          vadService.resume();
          useConversationStore.getState().setPipelineStage('listening');
        }
      }, POST_TTS_COOLDOWN_MS);
    }
  });

  // Handle VAD events (speech_start and speech_end)
  unsubscribeVad = vadService.onEvent(event => {
    if (event === 'speech_start') {
      // Decide streaming vs offline for THIS utterance at onset time
      utteranceIsStreaming = streamingPipeline.isAvailable();
      console.log('[VADController] speech_start — streaming:', utteranceIsStreaming);
      if (utteranceIsStreaming) {
        void streamingPipeline.startUtterance().catch(e => {
          console.error('[VADController] Streaming start failed, will fall back to offline:', e);
          utteranceIsStreaming = false;
        });
      }
      // VAD always accumulates chunks regardless — offline fallback always has data
      return;
    }

    if (event === 'speech_end') {
      console.log('[VADController] speech_end — streaming:', utteranceIsStreaming, 'isStreaming:', streamingPipeline.isStreaming);
      if (utteranceIsStreaming && streamingPipeline.isStreaming) {
        // Streaming succeeded — finalize via streaming pipeline.
        // Discard VAD chunks (streaming already processed them).
        vadService.collectSpeechChunks();
        void streamingPipeline.endUtterance().catch(e => {
          console.error('[VADController] Streaming end failed:', e);
        });
      } else {
        // Offline fallback: streaming not available or failed mid-utterance.
        // Cancel any partial streaming state.
        if (utteranceIsStreaming) {
          void streamingPipeline.cancelUtterance().catch(() => {});
        }
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
      utteranceIsStreaming = false;
    }
  });

  // Start continuous audio streaming → VAD + streaming ASR
  audioCaptureService.startStreaming(base64Pcm => {
    vadService.processChunk(base64Pcm);

    // Feed audio to streaming pipeline when actively streaming
    if (utteranceIsStreaming && streamingPipeline.isStreaming) {
      void streamingPipeline.feedAudioChunk(base64Pcm).catch(() => {});
    }
  });

  useConversationStore.getState().setPipelineStage('listening');
}

export function stopVADMode(): void {
  if (!active) return;
  active = false;

  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  // Cancel any in-flight streaming utterance
  void streamingPipeline.cancelUtterance().catch(() => {});

  void audioCaptureService.stopStreaming();
  vadService.stop();

  unsubscribeStore?.();
  unsubscribeVad?.();
  unsubscribeStore = null;
  unsubscribeVad = null;
  utteranceIsStreaming = false;

  useConversationStore.getState().setPipelineStage('idle');
}

export function isVADActive(): boolean {
  return active;
}
