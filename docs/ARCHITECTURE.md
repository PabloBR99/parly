# Architecture

Deep dive into how Parly works. For the short version, read the [README](../README.md) first.

## Pipeline

Every turn runs the same streaming pipeline; no stage waits for the previous one to fully finish:

```
PTT held ──► AudioCaptureService (PCM 16kHz mono, base64 frames)
                    │
                    ▼
              VoxtralRealtimeClient (WebSocket)
                    │  transcription.text.delta  → live partial
                    │  transcription.done        → final
                    ▼
              MistralTranslator (POST /v1/chat/completions, SSE)
                    │  sentence-boundary chunking (regex, min 15 chars)
                    │  per-sentence emit
                    ▼
              NativeTTSService.speakChunk()  ── queued in native engine
                    │  await Promise.all of all chunks
                    │  + 250ms tail silence (Android sink flush)
                    ▼
                turn done — half-duplex lock released
```

Translation streams sentence-by-sentence, so TTS starts speaking the first sentence while the second is still arriving from the model. Display streams token-by-token — sentences are the unit for TTS, not for eyes.

## Push-to-talk state machine

The orchestrator owns a strict per-turn state machine:

```
idle ─► recording ─► transcribing ─► translating ─► speaking ─► idle
                                                       │
                                                       └── error ─► idle
```

Every transition is guarded; the lock release is a single bottleneck. Why so strict? The worst failure for a face-to-face translator isn't a slow turn — it's a *confused* turn (mic still hot during TTS, two turns interleaved, a lock leak preventing the next press from working). Hard sequential states make every code path provably terminate.

**Tap-to-interrupt:** while a turn is `translating`/`speaking`, tapping the translated text cancels it — TTS stops, the lock releases. A half-duplex lock without an abort is an elevator with no door-open button.

**Adaptive finalization:** the wait for Voxtral's final transcript scales with how long the user spoke (`3 s + 25 % of speech length, capped at +7 s`), and a flush that times out salvages the accumulated partial text instead of discarding the turn — long monologues degrade gracefully instead of erroring.

## Hands-free mode

With hands-free enabled, nobody presses anything: on-device VAD (Silero v5 via `onnxruntime-react-native`, 512-sample frames @ 16 kHz) detects speech starts and ends, and a second state machine takes turns:

```
hf-idle ─► hf-capturing ─► hf-flushing ─► hf-routing ─► hf-speaking ─► hf-cooldown ─► hf-idle
```

- **Turn-taking:** a pause longer than 600 ms ends the utterance and dispatches it. Live partials render on the speaker's half while they talk.
- **Routing:** the turn's direction is decided from the *transcript text* (script/stopword classification), not just Voxtral's audio language tag — this is what prevents same-language echo loops when the tag misfires.
- **Echo gating:** while the phone speaks (and for a 250 ms cooldown after), mic audio is not fed to the transcriber and the VAD is disarmed, so the phone never transcribes its own voice. On re-arm, the transcriber's utterance buffer is reset to scrub anything that leaked in flight. This is deliberate: hardware echo cancellation (`VOICE_COMMUNICATION`) is too device-dependent to rely on.
- **The trade-off:** speech during playback is not captured (half-duplex by design). Tapping the streaming translation skips the readback and returns to listening in ~250 ms.

## Key design decisions

1. **Cloud STT + cloud translation, OS-native TTS.** Voxtral handles 30+ languages with quality far above a phone-bundled whisper-small, at a fraction of the install footprint. TTS is OS-native — zero install, voices already on the device. The only on-device model is Silero VAD (2.3 MB ONNX in the APK), so hands-free turn detection never sends audio anywhere until someone is actually speaking.

2. **Streaming end to end.** Voxtral WS streams partials; Mistral SSE streams translation tokens; TTS queues sentences as they boundary-fire. There is no "wait until done" anywhere in the path.

3. **Fresh WebSocket per turn.** Idle WebSockets are subject to opaque server-side timeouts (30–90 s observed) and network-change drops on mobile. Each turn opens a new socket; TLS session reuse keeps subsequent handshakes at ~50–150 ms. (Hands-free keeps one session open and resets the utterance between turns instead.)

4. **Injection-resistant translation prompt.** Transcripts are wrapped as *speech to translate*, never as chat input — a speaker saying "ignore previous instructions" gets those words translated, not obeyed.

5. **API key in the OS keychain.** `react-native-keychain` keeps the key in the Android Keystore. It only ever appears in the `Authorization: Bearer …` header on requests to `api.mistral.ai`. No telemetry, no analytics.

6. **Every failure is one plain sentence** on the half of the person who can act, in their language: connection dropped, key stopped working, rate limited, "I didn't catch that", mic permission, missing TTS voice, offline. Raw errors go to the diagnostics log only. Cancelled turns show nothing — user intent is not an error.

## UI design

**Design language:** editorial dark, restrained palette. Two quiet accents — platinum amber `#F2B473` for Person A, ice blue `#86BFFF` for Person B. Depth on true black via translucent halos, never drop shadows.

**Spatial logic:** the phone lies flat between two speakers. Each person's PTT sits at *their physical edge* of the device — partner's at the top (the whole top half is wrapped in `rotate(180deg)`), user's at the bottom — so thumbs land naturally. There is no divider line; the space between the two halves is the seam, and the hands-free toggle lives on it.

**Bilingual by construction:** each half renders *all* of its chrome — stage microcopy, notices, welcome copy, the network pill, the hands-free hint — in that half's reader's language (`src/i18n/strings.ts`, 32 languages). There is no shared "app language".

**Felt rhythm:** haptics mark each stage transition (press → recording → transcribing → translating → first spoken token → done/error) so the user knows where the machine is without reading the screen. Status microcopy beside the state glyph says it in words (`escuchando` on the Spanish half, `聞いています` on the Japanese half).

**Discoverability without chrome:** first-run hints ("press and hold to speak", the hands-free label on the seam) are quiet, localized per half, and retire themselves permanently after first successful use.

**Per-side history:** each half is a scroll feed in reading order — your own words in small serif, what the partner said (translated) in sans, the latest incoming message hero-sized with an adaptive type scale. Auto-scroll sticks to the newest message and detaches when the reader scrolls back; a `↓` chip jumps back to live.

## API-key onboarding

The hard barrier for non-technical users isn't the conversation — it's the API key. The first-run flow is three plain-language steps (open Mistral console → copy key → paste and verify) with zero jargon: the strings "Authorization", "sk-", "keychain" and "endpoint" never appear. The paste box is visible, not masked, so the user can see the paste took the whole key. Changing the key is non-destructive — the working key keeps working until a *new* key verifies, so no single tap can strand the user keyless.

## Project structure

```
src/
├── app/            # Language metadata, shared types
├── i18n/           # Per-half surface strings, 32 languages
├── store/          # Zustand: conversation, settings (persisted), network
├── services/
│   ├── pipeline/   # ConversationOrchestrator — both state machines, DI wiring
│   ├── stt/        # VoxtralRealtimeClient — WebSocket + frame protocol
│   ├── translation/# MistralTranslator — SSE streaming + sentence chunks
│   ├── tts/        # react-native-tts wrapper
│   ├── audio/      # PCM capture
│   ├── vad/        # Silero VAD over onnxruntime
│   ├── network/    # Connectivity monitor + Mistral reachability probe
│   ├── auth/       # Key validation (GET /v1/models)
│   ├── storage/    # Keychain wrapper
│   └── log/        # In-memory ring buffer for the Logs screen
├── ui/             # Primitives, animations, theme, haptics
├── screens/        # Conversation, LanguagePair, Settings, Logs
└── navigation/
```
