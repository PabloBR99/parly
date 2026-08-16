# Parly

**Real-time conversation translator for two people sharing one phone.**

Lay the phone flat on the table. Each half of the screen faces one speaker — rotated so both read upright. One person talks; the other reads the translation as it streams in and hears it spoken aloud moments later. Push-to-talk, or fully hands-free.

<div align="center">
<table>
  <tr>
    <td align="center" width="50%"><img src="docs/demo.gif" width="270" alt="Push-to-talk demo: the Spanish half at the top rotated 180° asks 'Hola, ¿cómo te llamas?', the English half at the bottom shows the streaming translation 'Hi, what's your name?', and the reply flows back the other way." /></td>
    <td align="center" width="50%"><img src="docs/demo-handsfree.gif" width="270" alt="Hands-free demo: the welcome cards read 'Just speak.' — with no button presses, 'Hi, what's your name?' streams onto the Spanish half as 'Hola, ¿cómo te llamas?' and the reply flows back, voice activity detection taking the turns." /></td>
  </tr>
  <tr>
    <td align="center" width="50%"><sub><b>Push-to-talk</b> — hold, speak, release</sub></td>
    <td align="center" width="50%"><sub><b>Hands-free</b> — VAD takes the turns</sub></td>
  </tr>
</table>

<sub><a href="docs/demo-handsfree.mp4">🔊 Watch the hands-free demo with sound</a></sub>
</div>

Built on [Mistral](https://mistral.ai)'s realtime APIs — Voxtral for streaming speech-to-text, chat completions for streaming translation — with the OS's own text-to-speech voices. Bring your own (free) Mistral API key; the app has no backend of its own.

## Features

- **Two-sided by construction** — every piece of UI on each half (status, notices, hints, history) renders in that half's reader's language. 32 languages.
- **Hands-free mode** — on-device voice activity detection (Silero VAD) takes turns automatically: talk, pause, hear the translation, reply. No buttons.
- **Streaming end to end** — transcription, translation and speech all stream; the first translated sentence is spoken while the rest is still arriving.
- **Long turns welcome** — live partial transcripts while you speak, adaptive timeouts, and graceful salvage if the connection hiccups mid-monologue.
- **Scrollable history** — each side can scroll back through the conversation in their own language, then jump back to live.
- **Interruptible** — tap the translation while it's being spoken to skip the readback.
- **Names spelled right** — proper nouns are what speech recognition gets wrong most, and the one thing a realtime socket cannot be biased towards. Parly keeps a glossary of the people in the conversation, repairs the transcript towards it phonetically, and hands it to the translator as well.
- **Private by design** — no backend, no telemetry, no accounts. The only server the app ever talks to is `api.mistral.ai`, under your own key.

## Languages

English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Ukrainian, Polish, Czech, Greek, Turkish, Arabic, Hebrew, Persian, Hindi, Bengali, Urdu, Chinese, Japanese, Korean, Vietnamese, Thai, Indonesian, Swedish, Norwegian, Danish, Finnish, Romanian, Hungarian and Swahili — any pair, in either direction.

Transcription quality is not flat across that list. Voxtral's realtime model is trained and evaluated on thirteen: **English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Arabic, Hindi, Chinese, Japanese and Korean**. The rest still work — the surface, the routing and the translation are all built for them — but the transcript is where the difference shows.

Spoken output uses the voices installed on the device; if the OS has no voice for a language, Parly shows the text and tells the listener rather than reading it with a wrong-language voice.

## Getting started

### Install the APK (Android 7+, arm64)

Download `app-release.apk` from the [latest release](https://github.com/PabloBR99/parly/releases). On first launch the app walks you through creating a free Mistral API key — three steps, no jargon.

### Build from source

```bash
npm install
npm start          # Metro bundler
npm run android    # in a second terminal, with a device/emulator attached
```

> **Android only for now.** The `ios/` directory is standard React Native scaffolding, but there is no functional iOS build — the audio pipeline has never been wired or tested on iOS. Contributions welcome.

## How it works

```
mic ──► Voxtral realtime (WebSocket) ──► Mistral chat (SSE) ──► OS text-to-speech
         streaming transcription          streaming translation     spoken per sentence
```

Transcription is tuned for the word, not the millisecond: the recogniser gets 480 ms of right context before it commits (Mistral's own figure for where the realtime model matches their offline one), and the mid-utterance flush that shortens the wait is held until the transcript stops growing, so it can never cut through a word still being written. Settings → *Transcription* trades that back for ~160 ms if you want it.

A strict half-duplex state machine drives each turn: the microphone and the speaker are never live at the same time, so the phone can't transcribe its own voice. In hands-free mode, on-device VAD detects when you stop talking (600 ms of silence) and dispatches the turn; while the phone speaks, the mic is gated and re-armed clean afterwards. Turn direction is decided from the transcript itself, not just the audio's language tag — which is what keeps same-language misdetections from echo-looping.

The full picture — state machines, echo gating, latency decisions, the UI design language — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

| | |
|---|---|
| **App** | React Native 0.84 (bare) + TypeScript, Reanimated 4, Zustand 5 |
| **Speech-to-text** | Voxtral realtime over WebSocket (`voxtral-mini-transcribe-realtime-2602`) |
| **Translation** | Mistral chat completions, streaming SSE (`mistral-small-latest`) |
| **Text-to-speech** | `react-native-tts` — OS-native voices |
| **Voice activity detection** | Silero VAD v5 on-device via `onnxruntime-react-native` |
| **Key storage** | `react-native-keychain` (Android Keystore) |

## Development

```bash
npm test             # Jest — 298 tests
npm run lint         # ESLint, then Oxlint + anti-slop
npm run typecheck    # tsc --noEmit
```

CI builds a release APK and publishes a `dev-<sha>` prerelease on every push to `main`.

### anti-slop

Lint runs [anti-slop](https://github.com/dmmulroy/anti-slop) — opinionated Oxlint rules that reject low-evidence typing — with all fifteen rules at `error`. The plugin is vendored at `tools/oxlint/anti-slop/`, as it is meant to be; `.oxlintrc.json` is where it is configured.

What it enforces, in short: values crossing an I/O boundary get decoded there, once, into a named type — not carried around as `unknown` and re-inspected with `typeof` wherever they happen to be used. Two modules exist for that:

- **`src/app/json.ts`** — `JsonValue`, `JsonObject`, and the guards over them. Every runtime `typeof` in the app lives here, which is why `no-runtime-typeof` runs with `allowInTypeGuards`.
- **`src/app/errors.ts`** — `toError` / `errorMessage` / `isAbortError`, for the one thing a `catch` block never knows the type of.

Two rules are relaxed, both narrowly and both in `.oxlintrc.json` with the reasoning next to them: `allowInTypeGuards` above, and `no-module-mocking` off for the four files that mock native modules — there is no JS implementation of Reanimated, the keychain, the TTS engine or the ONNX runtime to inject under Jest. It stays on everywhere else, so mocking one of *our* modules is still an error: services take their dependencies as parameters instead (the WebSocket factory, the streaming fetcher, the ONNX session factory, `App`'s reachability probe).

## Troubleshooting

- **TTS doesn't speak a language** — the OS has no voice installed for it. Android: *Settings → Accessibility → Text-to-speech → Install voice data*. The app shows the text and tells the listener, rather than reading it with a wrong-language voice.
- **Key won't verify** — regenerate it at [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) and paste the whole thing. If you're offline, verification retries automatically once you're back. *NOT A KEY — CHECK THE PASTE* means the clipboard held something else entirely (it happens); *KEY REJECTED* means the key reached Mistral and was turned down.
- **Logs** — Settings → *Diagnostics* → *View logs*. Raw pipeline errors land there; the conversation surface only ever shows plain-language notices.

## Privacy

Parly has no backend. Microphone audio streams directly from your device to Mistral's servers for transcription, and the transcribed text goes to Mistral's chat API for translation — all under **your** API key, governed by [Mistral's terms and privacy policy](https://mistral.ai/terms/). Conversation history lives only in memory on the device and disappears when the session ends. Your API key is kept in the platform secure store and leaves the device only to authenticate against Mistral's API.

## License

[MIT](LICENSE) © 2026 Pablo Bruno Romero
