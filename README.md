# Parly — Real-Time Conversation Translator

Bidirectional speech translation app. React Native (bare), Android-first. The phone is laid flat between two people; each half of the screen is rotated 180° so both speakers read upright from their side of the table. Half-duplex push-to-talk with streaming STT, streaming translation, and OS-native TTS — every stage starts before the previous one finishes.

Bring your own Mistral API key. The app guides non-technical users through getting one in three plain-Spanish steps the first time they open the app.

---

## Quick Start

```bash
npm install
npm start                 # Metro bundler
npm run android           # in another terminal
```

iOS first-time setup:
```bash
cd ios && bundle install && bundle exec pod install && cd ..
npm run ios
```

The app needs a Mistral API key on first run. The in-app onboarding opens [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) for you, explains how to generate a key, and walks you through pasting and verifying it.

---

## Stack

| Layer | Technology |
|-------|-----------|
| **UI** | React Native 0.84 (bare) + TypeScript, reanimated 4.3, react-native-safe-area-context |
| **State** | Zustand 5 (immutable) |
| **STT** | Voxtral realtime via WebSocket — `wss://api.mistral.ai/v1/audio/transcriptions/realtime` (model: `voxtral-mini-transcribe-realtime-2602`) |
| **Translation** | Mistral chat completions, streaming SSE — `mistral-small-latest` |
| **TTS** | `react-native-tts` (OS-native voices, per-language voice cache) |
| **Audio capture** | `react-native-audio-record` — PCM 16kHz mono, base64-framed |
| **Secret storage** | `react-native-keychain` — API key only, never leaves the device except in `Authorization: Bearer …` |
| **Tests** | Jest 29, 63 passing across orchestrator / Voxtral client / translator / network monitor |

No on-device ML models. No bundled audio assets. Footprint is the React Native runtime plus a thin native shim. The only egress is `api.mistral.ai`.

**Connectivity:** required during conversations. Failed handshakes surface in the UI as a network-state pill (`en línea` / `conectando` / `sin conexión`) and as a per-turn error pane.

---

## Architecture

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

The orchestrator owns a strict per-turn state machine:

```
idle ─► recording ─► transcribing ─► translating ─► speaking ─► idle
                                                       │
                                                       └── error ─► idle
```

Every transition is guarded; the lock release is a single bottleneck. Why so strict?

> In a diplomatic demo the worst failure isn't a slow turn — it's a *confused* turn (mic still hot during TTS, two turns interleaved, lock leak preventing the next press from working).

The WebSocket is opened fresh per turn. Idle WS connections are subject to opaque server-side timeouts and mobile network changes; the cost of a fresh connect is ~50–150 ms (TLS session reuse handles the warm path).

---

## UI — Vertical PTT Layout

**Design language:** editorial dark, restrained palette. Two quiet accents — **platinum amber** `#F2B473` for "you" / Person A, **ice blue** `#86BFFF` for "them" / Person B. Depth on true black via translucent halos, never drop shadows.

**Concept:** the phone lies flat between two speakers. Each person's PTT sits at THEIR PHYSICAL EDGE of the device — partner's at the top (rotated 180°), user's at the bottom — so thumbs land naturally. **No center divider line**; the silence between the two source lines IS the seam.

```
┌─────────────────────────────┐
│   ●  en línea               │  ← partner's edge chrome (network pill)
│                             │
│           ◯                 │  ← partner's PTT (rotated 180°)
│                             │
│   español  ▾   PENSANDO ◐   │  ← identity chip + state morph + microcopy
│                             │
│   Lo que el usuario         │  ← big translated text — what partner reads
│   acaba de decir            │     (tap to replay)
│                             │
│   — fuente —                │  ← source line (small, near center)
│                             │
│           (gap)             │  ← PURE SPACE — no divider line
│                             │
│   — fuente —                │
│                             │
│   What the partner          │
│   just said                 │
│                             │
│   english  ▾    ↺ REPETIR   │  ← identity chip + replay affordance
│                             │
│           ◯                 │  ← user's PTT
│                             │
│   ⌘  ajustes                │  ← user's edge chrome
└─────────────────────────────┘
```

Each `SpeakerHalf` is rendered top-down in reading order (source → big → identity → button → edge chrome). The top half wraps the whole stack in `transform: rotate(180deg)` so the partner sees everything upright from their side.

**PTTButton — object metaphor:**
- **96 pt disc** surrounded by an asymmetric watercolour bloom (three offset SVG radial gradients, not concentric halos).
- **Idle:** bloom breathes subtly (±1 px drift, opacities 0.92–1.00), with meditative tempos (7.4 / 8.0 / 8.6 s) that feel alive, not anxious.
- **Press:** disc scales by ~5 % (spring); halos brighten.
- **Active:** outer ring breathes outward every 1.6 s, a 5-bar waveform pulses inside the disc, bloom couples to the RMS of the incoming audio.
- **Label:** clean horizontal mic-affordance tick (14 × 1.5 pt) — **no language code text inside the disc** (removed in favor of accent tint; endonym lives in the identity chip above).

**Felt rhythm — haptic choreography across the turn:**

| Moment | Pattern |
|--------|--------|
| PTT press | `tap` (single short pulse) |
| `recording → transcribing` | `pulse` (two-step) |
| `transcribing → translating` | `pulse` |
| First spoken token (`translating → speaking`) | `tick` |
| Turn done | `done` (heavier two-step) |
| Turn error | `error` (three-step buzz) |
| Picker row tap | `tick` |

The turn has a felt rhythm that matches its visual rhythm — the user doesn't need to read the screen to know where the machine is.

**Tap-to-replay:** when a turn is `done` and there's translated text on screen, tapping the big text (or the quiet `↺ REPETIR` affordance in the chip row) re-speaks the partner's last translation via the OS TTS. Gated on idle so audio never collides with in-flight orchestrator TTS.

**Settling reveal:** incoming text fades AND drifts up 6 px on first appearance. Driven by a boolean transition (`hasIncomingText`), not by text length — so each streamed sentence doesn't re-trigger the entrance and jiggle the line back into place.

**Status microcopy beside `StateMorph`:** `ESCUCHANDO` / `PENSANDO` / `HABLANDO` / `ERROR`. The glyph alone was ambiguous; two words make the system audible.

**First-run hint:** the press-and-hold gesture isn't universal, especially for older users expecting a single tap, so a quiet italic `mantén pulsado para hablar` sits under each disc until the first turn from either side completes — then it disappears for good.

---

## API-Key Onboarding (Mom-Test)

The hard barrier for non-technical users isn't the conversation — it's the API key. The first-run Settings screen replaces every piece of jargon with plain Spanish and a guided three-step flow.

```
Bienvenido
Vamos a poner Parly en marcha en tres pasos.

①  Crea tu cuenta en Mistral
   Es gratis y solo necesitas un correo electrónico.
   [ Abrir Mistral  ↗ ]                          ← Linking.openURL

②  Copia tu clave
   Una vez dentro, pulsa "Create new key". Aparecerá un código
   largo en pantalla — mantenlo pulsado y copia el texto entero.

③  Pégala aquí debajo
   [_______________________________________]
   Mantén el dedo sobre el cuadro y pulsa Pegar.

   [ Verificar clave ]                           ← primary button

   ✓  Listo. Ya puedes empezar a hablar.
   [ Empezar a hablar  → ]                       ← navigation.goBack()
```

What's *not* there: the strings "API key", "Authorization", "sk-", "llavero", "endpoint". When the user already has a working key, this whole flow collapses to a compact **`● Conectado a Mistral`** card with `COMPROBAR` and `CAMBIAR CLAVE` buttons. Diagnostic and history sections appear only after a connection is established, so first-run focus stays on the welcome.

---

## Project Structure

```
parly/
├── src/
│   ├── app/
│   │   ├── languages.ts             # Language metadata (endonym, emoji, scripts)
│   │   └── types.ts                 # PersonId, Language, etc.
│   ├── store/
│   │   ├── conversationStore.ts     # Turns, active turn id, stage transitions
│   │   ├── settingsStore.ts         # PersonA/B language, API key, model id
│   │   └── networkStore.ts          # 'unknown' | 'online' | 'offline'
│   ├── services/
│   │   ├── pipeline/
│   │   │   ├── ConversationOrchestrator.ts  # The state machine
│   │   │   └── orchestrator.ts              # Singleton DI wiring
│   │   ├── stt/
│   │   │   └── VoxtralRealtimeClient.ts     # WebSocket + frame protocol
│   │   ├── translation/
│   │   │   └── MistralTranslator.ts         # SSE streaming + sentence chunks
│   │   ├── tts/
│   │   │   └── NativeTTSService.ts          # react-native-tts wrapper
│   │   ├── audio/
│   │   │   └── AudioCaptureService.ts       # PCM 16kHz mono base64
│   │   ├── auth/
│   │   │   └── validateApiKey.ts            # GET /v1/models probe
│   │   ├── network/
│   │   │   ├── NetworkMonitor.ts
│   │   │   ├── monitor.ts
│   │   │   └── mistralProbe.ts              # connectivity probe
│   │   ├── storage/
│   │   │   └── secureStorage.ts             # react-native-keychain wrapper
│   │   └── log/
│   │       └── logStore.ts                  # in-memory ring buffer for the Logs screen
│   ├── ui/
│   │   ├── primitives/
│   │   │   ├── PTTButton.tsx                # The hero object
│   │   │   ├── LanguagePickerSheet.tsx      # Reanimated overlay (top or bottom, rotated for partner)
│   │   │   ├── LanguageCard.tsx
│   │   │   ├── SwapButton.tsx
│   │   │   ├── Surface.tsx
│   │   │   ├── Button.tsx
│   │   │   └── Text.tsx
│   │   ├── animations/
│   │   │   ├── Waveform.tsx
│   │   │   ├── Bloom.tsx                    # Watercolour stains (asymmetric, three SVG radial gradients)
│   │   │   └── StateMorph.tsx               # idle/recording/translating/speaking
│   │   ├── theme.ts                         # Diplomatic design tokens
│   │   ├── haptics.ts                       # tap/pulse/tick/done/error
│   │   └── index.ts
│   ├── screens/
│   │   ├── ConversationScreen.tsx           # Main bidirectional surface
│   │   ├── LanguagePairScreen.tsx           # First-run language setup
│   │   ├── SettingsScreen.tsx               # Onboarding + connection status
│   │   └── LogsScreen.tsx                   # Diagnostics
│   └── navigation/
│       └── types.ts
├── android/                                  # Bare RN Android shell
├── ios/                                      # Bare RN iOS shell
├── __tests__/                                # App-level integration test
└── App.tsx
```

---

## Key Design Decisions

1. **Cloud STT + cloud translation, OS-native TTS.** Voxtral handles 30+ languages with quality far above what a phone-bundled whisper-small could deliver, at a fraction of the install footprint. Translation streams sentence-by-sentence via Mistral SSE so TTS starts speaking the first sentence while the second is still arriving from the model. TTS itself is OS-native (zero install, voices already on the device).

2. **Streaming end to end.** Voxtral WS streams partial transcriptions; Mistral SSE streams translation tokens; TTS queues sentences as they boundary-fire. There's no "wait until done" anywhere in the path. The first audible word arrives a beat after the user releases PTT, not after the full translation lands.

3. **Strict half-duplex state machine.** Mic and speaker are never live at the same time. The lock release is the single auditable bottleneck. Hard sequential states make every code path provably terminate and prevent the worst failure mode for a face-to-face translator: an interleaved/confused turn.

4. **Fresh WS per turn.** Idle WebSockets are subject to opaque server-side timeouts (30–90 s observed) and to network-change drops on mobile. Each turn opens a new socket; TLS session reuse keeps subsequent handshakes at ~50–150 ms.

5. **API key in OS keychain.** `react-native-keychain` keeps the key in iOS Keychain / Android Keystore. It only ever appears in the `Authorization: Bearer …` header on requests to `api.mistral.ai`. No telemetry. No analytics.

6. **Vertical PTT axis, no divider, halos for depth.** See UI section. The phone-on-the-table metaphor is the spatial logic for the whole screen.

7. **Mom-tier onboarding.** Every piece of API-key jargon was stripped from the first-run flow. If a non-technical user can get a working key without help, the rest of the conversation UI is already legible (PTT + halos + microcopy + first-run hint).

---

## Recent Shipped Changes

**Language Picker Overlay (`3ef41cd`, `c11602e`):** Replaced native `<Modal animationType="slide">` with an in-screen Reanimated overlay anchored to either edge. Android's Dialog window was producing a visible upward jump on touch no matter the fix; an overlay that only translates (never unmounts) sidesteps the entire native layer. New `side` prop: `'top'` docks to screen-top with 180° rotation for the partner's view, `'bottom'` is the conventional behavior. `ConversationScreen` now renders two pickers (one per slot), each with its own frozen `excludeCode` snapshotted via a render-time ref so the list size never changes mid-animation.

**Bloom redesign (`f7dfd68`):** The HTML mockup uses `filter: blur(30px)` + `mix-blend-mode: screen` — RN can't do either, so a 280 px tight-falloff bloom rendered as a small dim ring on the disc instead of the wide painted wash of the mockup. Three changes: `BLOOM_SIZE` 280 → 480 pt to span the full half of the screen edge-to-edge; stops `0/.18/.42/.72/1` → `0/.22/.50/.80/1` with alpha factors `1/.66/.32/.11/0` → `1/.78/.50/.22/0` so visible alpha carries to ~80 % of radius (the "blur substitute"); peak alphas bumped (warm 0.42/0.38/0.34 → 0.55/0.50/0.45, cool 0.48/0.44/0.40 → 0.62/0.56/0.50) to compensate for missing screen-blend. Stain offsets scaled ~1.7× to keep the painterly asymmetric silhouette in the bigger bloom.

**PTTButton polish (`65a17ce`, `3ef41cd`):** Language code text inside the disc removed; without it the disc was near-invisible, so the idle shell is now tinted with the speaker accent — `bg = ${accent}1A` (10 %) idle / `${accent}26` (15 %) active; `border = ${accent}66` (~40 %) idle / `accentRing` active. Accessibility label still exposes the language code for screen readers.

**Settings keyboard handling (`65a17ce`):** Replaced the brittle `scrollToEnd-on-focus` with a `Keyboard.didShow` listener that measures the API-key input's position, computes overlap with the keyboard, and scrolls it ~48 px above the keyboard edge so long-press → Paste is comfortable. Dropped `KeyboardAvoidingView` (Android `adjustResize` handles the heavy lifting). Bumped bottom padding to give the ScrollView room to scroll the input that high. Light Dusk pass on the header (`DuskBackdrop`, peach/periwinkle dot eyebrow, `serifHero` "Welcome." / "Settings.").

**LanguagePair copy + sizing (`79f9a83`):** Headline changed from "Two suns meeting at the edge of the day." to "A live translator for two voices." `LanguageCard` endonym dropped from `displayHuge` (48 px) to `displayLarge` (36 px) — subtle scale-down so the card breathes more.

## Roadmap

| Phase | Status | Highlights |
|-------|--------|-----------|
| **0** — Spike: on-device STT + voice cloning | Discarded | whisper.rn (no Voxtral support) and ZipVoice/sherpa-onnx voice-cloning evaluated; abandoned in favor of cloud STT for quality + footprint. |
| **1–4** — Earlier on-device pipeline | Superseded | See `PLAN.md` for the historical phase log. |
| **v4 pivot** — Voxtral + Mistral + native TTS | ✅ | New orchestrator, streaming end-to-end, half-duplex lock, Mistral key validation. |
| **v5 — UI redesign** | ✅ commit `a43525e` | Vertical PTT axis, bloom disc, editorial restraint, Diplomatic theme. |
| **v5.1 — Picker overhaul + bloom + settings** | ✅ commits `65a17ce` → `f7dfd68` | Reanimated dual-side picker, BLOOM_SIZE 280→480 with softer falloff, accent-tinted PTT, settings keyboard scroll-to-input. |
| **v6 — Final polish** | ✅ commit `a34e6e7` | Haptic choreography, tap-to-replay, status microcopy, settling reveal, first-run hint, mom-tier onboarding. |

---

## Troubleshooting

**"Falta la API key" banner won't go away after pasting:**  
Tap **Verificar clave**. Successful validation flips the banner. If you see `KEY RECHAZADA`, the key is invalid; regenerate it in [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys). If you see `SIN RED`, your phone is offline.

**TTS doesn't speak in the target language:**  
The OS may not have a voice installed for that language. On Android, open *Settings → Accessibility → Text-to-speech → Install voice data* and download the language pack. The translation still appears on screen even when TTS can't speak it.

**Picker animates erratically when you select a language:**  
Fixed in commit `a34e6e7` (frozenExclude snapshot). Pull `main`.

**Metro bundler issues:**
```bash
npm start -- --reset-cache
```

**iOS Pod install fails:**
```bash
cd ios && rm -rf Pods Podfile.lock && bundle exec pod install && cd ..
```

**Logs:** Settings → *Diagnóstico* → *Ver logs* (only visible after a key is configured).

---

## References

- **Mistral Voxtral (audio realtime):** https://docs.mistral.ai/api/#tag/audio/operation/audio_transcriptions_realtime_v1_audio_transcriptions_realtime_get
- **Mistral chat completions (translation backbone):** https://docs.mistral.ai/api/#tag/chat
- **react-native-tts:** https://github.com/ak1394/react-native-tts
- **react-native-keychain:** https://github.com/oblador/react-native-keychain
- **Reanimated:** https://docs.swmansion.com/react-native-reanimated/
- **React Native:** https://reactnative.dev
