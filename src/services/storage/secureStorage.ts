// Secure storage wrapper — currently used for the Mistral API key.
//
// react-native-keychain stores values in the Android Keystore / iOS Keychain,
// so the key survives app restarts but isn't trivially exfiltrated by other
// apps or ADB pulls. Any read/write is async; callers typically fire-and-forget
// on writes and only await on startup hydration.
//
// We don't throw on missing/errored reads — if the keychain is unavailable
// (emulator without lock screen, corrupt store, etc.) the user just re-enters
// the key. Failing loudly here would block app start for something recoverable.

import * as Keychain from 'react-native-keychain';

const MISTRAL_KEY_SERVICE = 'com.parly.mistral.apikey';

export async function loadMistralApiKey(): Promise<string> {
  try {
    const creds = await Keychain.getGenericPassword({ service: MISTRAL_KEY_SERVICE });
    return creds ? creds.password : '';
  } catch (e) {
    console.warn('[secureStorage] Failed to read Mistral API key:', e);
    return '';
  }
}

export async function saveMistralApiKey(apiKey: string): Promise<void> {
  try {
    if (!apiKey) {
      await Keychain.resetGenericPassword({ service: MISTRAL_KEY_SERVICE });
      return;
    }
    await Keychain.setGenericPassword('mistral', apiKey, { service: MISTRAL_KEY_SERVICE });
  } catch (e) {
    console.warn('[secureStorage] Failed to write Mistral API key:', e);
  }
}
