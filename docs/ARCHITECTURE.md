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

- **Turn-taking:** a pause longer than 600 ms ends the utterance and dispatches it — unless the transcript ends it sooner (see *Endpointing* below). Live partials render on the speaker's half while they talk.
- **Routing:** the turn's direction is decided from the *transcript text* (script/stopword classification), not just Voxtral's audio language tag — this is what prevents same-language echo loops when the tag misfires.
- **Echo gating:** while the phone speaks (and for a 250 ms cooldown after), mic audio is not fed to the transcriber and the VAD is disarmed, so the phone never transcribes its own voice. On re-arm, the transcriber's utterance buffer is reset to scrub anything that leaked in flight. This is deliberate: hardware echo cancellation (`VOICE_COMMUNICATION`) is too device-dependent to rely on.
- **The wave is the meter:** the same 512-sample frames that drive turn detection also carry a loudness measurement (RMS → dBFS → envelope follower) that is published on `services/audio/audioLevelBus` and drawn as the seam control's wave. It travels the pub/sub bus rather than the store because 31 updates/s through Zustand would re-render the whole two-sided surface to move seven 2 px bars. The gate above applies to the meter too — audio the phone is hearing from its own speaker moves nothing, so the wave can never visualise the app's own voice.
- **The trade-off:** speech during playback is not captured (half-duplex by design). Tapping the streaming translation skips the readback and returns to listening in ~250 ms.

### The wait between "…?" and the answer

Everything from the last syllable to the first spoken word is one serial chain, and each link was bought back with evidence rather than by shortening a timeout:

```
silence ─► endpoint ─► transcript ─► translation ─► first sentence ─► first audio
          hangover     flush→final     TTFT          boundary          engine
          ~600 ms      ~400-600 ms   ~300-500 ms    ~200 ms          ~250-400 ms
```

- **Endpointing is two-stage.** Silence is weak evidence that a person finished talking — strong enough only after a long wait, which is why the hangover sits at the front of every reply. So the VAD also emits an early *pause hint* at 400 ms, and the orchestrator answers it with evidence the VAD doesn't have: whether the transcript just closed a sentence. Voxtral punctuates, and a full stop is the one signal that distinguishes finishing a thought from drawing breath. A hint over a transcript that stops mid-clause is ignored and the full hangover runs. This matters because the hangover is not padding: an utterance split in two loses its second half, which arrives while the mic is gated behind the readback of the first.

- **The final is usually a formality.** The flush→final round trip asks the server for a transcript it has already streamed: Voxtral buffers `target_streaming_delay_ms` of audio, and the silence the endpointer just waited through is longer than that, so by the time a turn ends the deltas normally carry every word of it. `commitUtterance()` takes what has arrived and closes the segment without blocking on the answer. The guard is that the transcript must have *stopped growing* (140 ms with no delta) — anything still arriving is the tail of the sentence, and this drops it.

- **Both shortcuts refuse unless the text alone routes the turn.** Skipping the final also skips the audio language tag that comes with it, so they only fire when the transcript classifier is outright certain which half the turn belongs to. A fast turn delivered to the wrong reader is worse than a slow one, and slow is always still available.

- **Nothing is warmed in front of the sentence that matters.** Both voices of the pair are primed when hands-free starts, before anyone has spoken. The silent primer costs a real synth-and-play cycle in the native engine, so re-warming an already-hot voice queues *ahead* of the real sentence and adds the latency it was meant to remove — it is skipped unless the voice changed or went cold.

- **The measurement starts where the person starts waiting.** The `[hf_turn]` log line breaks the whole chain into segments that add up, measured from the last speech frame (not from when the hangover conceded) to the `tts-start` event (not to when a chunk was queued). `speechEndToAudio` is the number; everything else in the line explains it. Tuning any of the constants above without reading it first is guessing.

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

**Honest instruments:** the hands-free control on the seam is a seven-bar wave that ripples outward from its centre — the app's spatial grammar, energy leaving the encounter line in both directions. While it is listening, the bar heights are the microphone: a silent room gets a slow low roll ("armed"), a voice fills them. It is deliberately *not* a canned loop, because the one question hands-free has to answer at a glance is "is it hearing me?", and a decorative animation answers it wrongly. While the phone is speaking, the wave switches to a synthetic swell — the OS speech engine exposes no output level, and mirroring the mic there would be drawing the phone's own voice.

**Felt rhythm:** haptics mark each stage transition (press → recording → transcribing → translating → first spoken token → done/error) so the user knows where the machine is without reading the screen. Status microcopy beside the state glyph says it in words (`escuchando` on the Spanish half, `聞いています` on the Japanese half).

**No edges, anywhere.** This is a hard rule, not a preference. Nothing in the UI may show the boundary of its own box: no rectangle of tint, no scrim with a hard lip, no gradient that stops rather than dissolves. Against near-black, ~3 % of held light in a straight line is already enough to read as a line — which is how a dark overlay meant to be invisible ends up drawing the shape of its container. Two consequences that keep biting:

- A veil that *darkens the background* can never be edge-free, because its boundary is a step in background brightness. Fading scrolled text needs a mask (set the text's own alpha, leave the background alone), not a scrim (darken everything). The history's ends use `FadeEdges`, a `MaskedView` wrapper; the scroll content is padded by the same amount as the fade bands, so resting text sits clear of them and only text on its way out of view ever dissolves.
- Soft falloff is not enough on its own if the element can be clipped. An element must either dissolve completely *within* its container, or bleed past a boundary the user cannot see (the physical screen edge). Relying on `overflow: visible` to save an oversized child is not a plan.

**Atmosphere is never idle:** when a hands-free turn crosses the seam, the horizon blooms once in the *receiving* reader's accent — peach downward, periwinkle upward — and drifts that way as it fades. It is a circular SVG radial gradient with a gaussian-like 10-stop falloff, squashed by a transform (elliptical gradients band visibly in `react-native-svg`), so alpha asymptotes to zero in every direction. It is sized so that its box at maximum spread still fits inside the screen — the rule above, applied: wherever the glow meets a boundary it is already fully transparent. And it is at zero the rest of the time: a glow that is always on is not atmosphere, it is a tint.

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
