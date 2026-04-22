// OnlineSttAdapter — SttAdapter backed by Mistral's Voxtral transcription API.
//
// Uses the REST batch endpoint (POST /v1/audio/transcriptions), not the WebSocket
// realtime API: the VAD-driven pipeline hands us complete WAV segments, so we
// don't gain anything from streaming while ASR and translation still happen
// after speech_end. A future PR can add a streaming adapter for the ACTIVE phase
// (mirroring Kroko's role on the offline path).
//
// Errors are thrown — the resolver + orchestrator decide whether to fall back
// to offline or propagate based on user preference (auto vs online-only).

import { useSettingsStore } from '../../store/settingsStore';
import type { SttAdapter } from './SttAdapter';
import type { TranscriptionResult } from '../../app/types';

const ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';
const MODEL = 'voxtral-mini-latest';
const REQUEST_TIMEOUT_MS = 15_000;

export class OnlineSttAdapterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OnlineSttAdapterError';
  }
}

class OnlineSttAdapter implements SttAdapter {
  readonly name = 'online' as const;

  async transcribe(audioPath: string, language?: string): Promise<TranscriptionResult> {
    const apiKey = useSettingsStore.getState().mistralApiKey;
    if (!apiKey) {
      throw new OnlineSttAdapterError('Missing Mistral API key');
    }

    // RN's FormData accepts a file-URI descriptor — the platform-native code
    // streams the file as multipart without loading it fully into JS memory.
    const form = new FormData();
    const uri = audioPath.startsWith('file://') ? audioPath : `file://${audioPath}`;
    const fileName = audioPath.split('/').pop() ?? 'audio.wav';
    // The RN typing for FormData.append is lax — the file descriptor is the RN idiom.
    form.append('file', {
      uri,
      type: 'audio/wav',
      name: fileName,
    } as unknown as Blob);
    form.append('model', MODEL);
    if (language) {
      form.append('language', language);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          // Intentionally no Content-Type — fetch sets multipart boundary from FormData.
        },
        body: form,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new OnlineSttAdapterError('Network error calling Voxtral', e);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new OnlineSttAdapterError(
        `Voxtral HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (e) {
      throw new OnlineSttAdapterError('Voxtral response was not JSON', e);
    }

    if (!isTranscriptionPayload(payload)) {
      throw new OnlineSttAdapterError('Voxtral response missing required fields');
    }

    return {
      text: payload.text.trim(),
      language: payload.language ?? language ?? 'auto',
    };
  }
}

function isTranscriptionPayload(v: unknown): v is { text: string; language?: string | null } {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.text !== 'string') return false;
  if (rec.language !== undefined && rec.language !== null && typeof rec.language !== 'string') {
    return false;
  }
  return true;
}

export const onlineSttAdapter: SttAdapter = new OnlineSttAdapter();
