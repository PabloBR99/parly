// Mistral-specific probe — aligns NetworkMonitor's 'online' signal with
// "Voxtral is actually reachable" rather than "there is an internet connection".
//
// Strategy:
//   - With API key set: GET https://api.mistral.ai/v1/models (validates reachability + auth).
//     A 401 from here means the key is bad; we treat that as reachable → online true, because
//     the STT adapter will surface a clearer error than "offline" would.
//   - Without API key: HEAD https://api.mistral.ai/ (reachability only). We still report online
//     when the host responds — the UI will show the auth error when a transcription is attempted.

import { useSettingsStore } from '../../store/settingsStore';
import type { ProbeFn } from './NetworkMonitor';

const MODELS_URL = 'https://api.mistral.ai/v1/models';
const HOST_URL = 'https://api.mistral.ai/';

export function createMistralProbe(): ProbeFn {
  return async (timeoutMs: number) => {
    const apiKey = useSettingsStore.getState().mistralApiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (apiKey) {
        const res = await fetch(MODELS_URL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        // 2xx = reachable + authed. 401/403 = reachable, bad key (adapter will surface).
        // 5xx = reachable but backend sick → treat as offline so auto mode bails out.
        return res.status < 500;
      }
      const res = await fetch(HOST_URL, { method: 'HEAD', signal: controller.signal });
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
