# Parly — Real-Time Conversation Translator

App de traducción de conversaciones bidireccional. El teléfono se coloca tumbado entre dos personas; cada mitad de la pantalla está rotada 180° para que ambos lean al derecho. Half-duplex push-to-talk con STT streaming, traducción streaming y TTS OS-nativo — cada etapa empieza antes de que la anterior termine.

Bring-your-own Mistral API key. La app guía a usuarios no técnicos a obtenerla en tres pasos en español plano la primera vez que abren Parly.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| UI | React Native 0.84 (bare) + TypeScript, reanimated 4.3, safe-area-context |
| Estado | Zustand 5 (inmutable) |
| STT | Voxtral realtime via WebSocket — `wss://api.mistral.ai/v1/audio/transcriptions/realtime` (model `voxtral-mini-transcribe-realtime-2602`) |
| Traducción | Mistral chat completions, streaming SSE — `mistral-small-latest` |
| TTS | `react-native-tts` (voces OS-nativas, cache por idioma) |
| Captura audio | `react-native-audio-record` — PCM 16 kHz mono, base64 |
| Secret storage | `react-native-keychain` — la API key solo viaja en `Authorization: Bearer …` a `api.mistral.ai` |
| Tests | Jest 29, 63 verdes (orchestrator / Voxtral client / translator / network monitor) |

Sin modelos ML on-device. Sin assets de audio bundled. La única egress es `api.mistral.ai`.

**Conectividad:** requerida durante conversaciones. El estado de red es visible en la chip-pill (`en línea` / `conectando` / `sin conexión`); los errores por turno se muestran en el panel del oyente.

---

## Arquitectura del pipeline

```
PTT pulsado ──► AudioCaptureService (PCM 16 kHz mono, base64)
                      │
                      ▼
                VoxtralRealtimeClient (WebSocket)
                      │  transcription.text.delta  → partial en vivo
                      │  transcription.done        → final
                      ▼
                MistralTranslator (POST /v1/chat/completions, SSE)
                      │  sentence-boundary chunking (regex, ≥ 15 chars)
                      │  emit por frase
                      ▼
                NativeTTSService.speakChunk()  ── cola en motor nativo
                      │  Promise.all de todos los chunks
                      │  + 250 ms tail silence (flush sink Android)
                      ▼
                  turno done — lock half-duplex liberado
```

State machine del orquestador:

```
idle ─► recording ─► transcribing ─► translating ─► speaking ─► idle
                                                       │
                                                       └── error ─► idle
```

Cada transición es guardada; el lock release es un único punto auditable. Por qué tan estricto:

> En una demo diplomática el peor fallo no es un turno lento — es un turno *confuso* (mic todavía caliente durante TTS, dos turnos interleaved, lock leak que impide la siguiente pulsación).

La WS se abre fresca por turno. WSs idle sufren timeouts opacos del servidor (30–90 s observados) y drops de cambio de red en mobile. El coste de una conexión nueva es ~50–150 ms (TLS session reuse mantiene la ruta cálida).

---

## UI — Vertical PTT Layout (Redesign v5, commit a43525e)

**Concepto:** el teléfono está tumbado sobre la mesa entre dos personas. Cada persona tiene su botón PTT en su EXTREMO FÍSICO del dispositivo — partner arriba (rotado), user abajo — así el pulgar cae naturalmente. El texto traducido se inclina hacia el centro, donde ocurre la conversación real. **No hay divisor hairline** — el silencio entre las dos líneas fuente ES el seam.

**Layout de `SpeakerHalf` (top-down, orden de lectura):**
1. Source line — texto capturado MIENTRAS habla, o fuente del partner post-turn (pequeño, near center)
2. Big translated text — `displayHero` (34 pt, weight 300, -0.6 tracking) — QUÉ LEE ESTA PERSONA
3. Identity chip — language endonym + state morph + microcopy (ESCUCHANDO / PENSANDO / HABLANDO)
4. PTT button — object metaphor con halos concéntricos translúcidos
5. Edge chrome — online/offline pill (partner) o `ajustes` link (user)

**PTTButton object metaphor:**
- Disc 96 pt con tres halos concéntricos que respiran en idle (3.2 s sine), se iluminan en press
- Activo: outer ring respira cada 1.6 s; waveform 30 pt alto, 5 barras
- Label: clean horizontal mic-affordance tick (14 × 1.5 pt) sobre language code
- Acentos: platinum amber `#F2B473` ("you") / ice blue `#86BFFF` ("them")
- Halos por acento: `accentGlow` (~0.10 opacity), `accentWhisper` (~0.045), `accentRing` (0.55)

**Theme tokens nuevos:**
- `color.accentAGlow`, `color.accentBGlow`, `color.accentAWhisper`, `color.accentBWhisper`
- `color.fgWhisper` (0.07 opacity) — nueva tier de foreground
- `font.displayHero` (34 pt, weight 300, -0.6 tracking) — main translated text
- `motion.glacial` (800 ms) — slow breath animation

---

## Estructura del proyecto

```
parly/
├── src/
│   ├── app/
│   │   ├── languages.ts             # Metadata: endonym, emoji, scripts
│   │   └── types.ts                 # PersonId, Language, etc.
│   ├── store/
│   │   ├── conversationStore.ts     # Turns, activeTurnId, transitions
│   │   ├── settingsStore.ts         # PersonA/B language, API key, model
│   │   └── networkStore.ts          # 'unknown' | 'online' | 'offline'
│   ├── services/
│   │   ├── pipeline/
│   │   │   ├── ConversationOrchestrator.ts
│   │   │   └── orchestrator.ts      # Singleton DI wiring
│   │   ├── stt/
│   │   │   └── VoxtralRealtimeClient.ts
│   │   ├── translation/
│   │   │   └── MistralTranslator.ts
│   │   ├── tts/
│   │   │   └── NativeTTSService.ts
│   │   ├── audio/
│   │   │   └── AudioCaptureService.ts
│   │   ├── auth/
│   │   │   └── validateApiKey.ts
│   │   ├── network/
│   │   │   ├── NetworkMonitor.ts
│   │   │   ├── monitor.ts
│   │   │   └── mistralProbe.ts
│   │   ├── storage/
│   │   │   └── secureStorage.ts     # react-native-keychain wrapper
│   │   └── log/
│   │       └── logStore.ts          # Ring buffer para LogsScreen
│   ├── ui/
│   │   ├── primitives/
│   │   │   ├── PTTButton.tsx
│   │   │   ├── LanguagePickerSheet.tsx
│   │   │   ├── LanguageCard.tsx
│   │   │   ├── SwapButton.tsx
│   │   │   ├── Surface.tsx
│   │   │   ├── Button.tsx
│   │   │   └── Text.tsx
│   │   ├── animations/
│   │   │   ├── Waveform.tsx
│   │   │   └── StateMorph.tsx
│   │   ├── theme.ts                 # Diplomatic design tokens
│   │   ├── haptics.ts               # tap/pulse/tick/done/error
│   │   └── index.ts
│   ├── screens/
│   │   ├── ConversationScreen.tsx
│   │   ├── LanguagePairScreen.tsx
│   │   ├── SettingsScreen.tsx       # Onboarding Mom-tier + estado de conexión
│   │   └── LogsScreen.tsx
│   └── navigation/
│       └── types.ts
├── android/                         # Bare RN Android
├── ios/                             # Bare RN iOS
├── __tests__/                       # Test integración App-level
└── App.tsx
```

---

## Fases

### Fases 0–4 — Camino on-device (DESCARTADO por el pivot a v4)

> **Contexto del pivot:** las fases 0–4 reflejan una primera arquitectura *all-on-device* (whisper.rn STT + iOS Translation framework / Android ML Kit + ZipVoice voice-cloning via sherpa-onnx). Se descartó al pivotar a un pipeline cloud (Voxtral STT + Mistral translation + TTS OS-nativo) porque la calidad multilingüe en cloud supera lo que cabe localmente, el footprint baja de ~800 MB a esencialmente cero, y el streaming end-to-end compensa la latencia de red. El log original se conserva aquí como registro del pivot, no como código actual.

<details>
<summary>Log histórico de Fases 0–4 (referencias y decisiones que YA NO aplican)</summary>

#### Fase 0 — Spike (validar antes de construir)
- Voxtral Q4 GGUF via llama.rn — **DESCARTADO** (2026-04-03): llama.rn sin API TTS output, codec VQ-FSQ sin implementar
- TTS alternativo evaluado: **ZipVoice distill-int8** via `react-native-sherpa-onnx` — VIABLE en el momento, finalmente descartado en el pivot v4
- Whisper small transcribe en <3s — pendiente cuando se pivotó
- ZipVoice + Whisper en memoria simultáneamente (~800 MB pico estimado) — preocupación que el pivot v4 elimina
- Voice cloning usando audio PTT como referencia (resample 16→24 kHz, trim 5 s) — abandonado en favor de TTS OS-nativo
- Fallback TTS: AVSpeechSynthesizer / Android TTS — pasó a ser el TTS principal en v4

#### Fase 1 — Shell + PTT + STT
- React Native project inicializado ✓
- Split-screen con rotación 180° — completado en v5 redesign con concepto distinto (vertical PTT axis)
- Grabación PTT → Whisper STT — sustituido por Voxtral WS streaming en v4

#### Fase 2 — Traducción
- iOS Translation bridge (Swift) — `TranslationBridge.swift` — sustituido por Mistral SSE en v4
- Android ML Kit bridge (Kotlin) — `TranslationModule.kt` — sustituido por Mistral SSE en v4
- PipelineOrchestrator inicial — refactorizado a `ConversationOrchestrator` con state machine estricta en v4

#### Fase 3 — TTS ZipVoice
- `react-native-sherpa-onnx@0.3.0` integrado, modelo `sherpa-onnx-zipvoice-distill-int8` (~104 MB) descargable
- `ZipVoiceService.ts` con `createTTS` / `TtsEngine` y `audioUtils.readWavAsVoiceRef`
- Probado en Android — funcionaba pero el pivot v4 abandonó voice-cloning para evitar el footprint de 104 MB y simplificar el pipeline

#### Fase 4 — VAD + Polish
- VAD energy-based con `VADService` + `VADController` + `WavWriter`
- StatusIndicator con dot pulsante — superseded por `StateMorph` en v5
- SettingsScreen inicial con `autoPlay` toggle, `ttsNumSteps` (5/10/15/20), borrar conversación — los toggles específicos de ZipVoice se eliminaron en el pivot v4

</details>

### Fase v4 — Pivot a cloud (Voxtral + Mistral + native TTS) ✅

- [x] **ConversationOrchestrator** — state machine half-duplex con guards estrictos por estado y lock auditable. Tests: `ConversationOrchestrator.test.ts`.
- [x] **VoxtralRealtimeClient** — WebSocket + frame protocol (`session.created`, `transcription.text.delta`, `transcription.done`, `error`). Tests: `VoxtralRealtimeClient.test.ts`.
- [x] **MistralTranslator** — `POST /v1/chat/completions` SSE con sentence-boundary chunking (regex multi-script, mín. 15 chars) para que TTS empiece antes de que termine la traducción. Tests: `MistralTranslator.test.ts`.
- [x] **NativeTTSService** — wrapper de `react-native-tts` con tracking per-utterance (match `utteranceId` en `tts-finish` / `tts-cancel` / `tts-error`) y queue cap de 15 s.
- [x] Singleton wiring en `orchestrator.ts`; `configure()` actualiza API key + modelo entre turnos sin recrear el orquestador.
- [x] `validateMistralApiKey` via `GET /v1/models` con clasificación `ok` / `invalid` / `network` / `httpStatus`.
- [x] `react-native-keychain` + `secureStorage.ts` para persistir la API key fuera del estado de Zustand.
- [x] `NetworkMonitor` + `mistralProbe` con chip-pill `en línea` / `conectando` / `sin conexión`.
- [x] Voxtral language hint, key validator inline, key prefix sanitization (commits `95d0eb0`, `e9b5b51`, `e907da0`).

### Fase 5 — UI Redesign ✅ (Commit a43525e)
- [x] **Vertical PTT axis:** Botón PTT en cada EXTREMO FÍSICO del teléfono (partner arriba, user abajo)
  - [x] Sin divisor central de hairline — el silencio entre dos líneas fuente ES el divisor
  - [x] Layout de lectura en `SpeakerHalf`: fuente → texto grande → chip identidad → PTT → edge chrome
  - [x] Rotación 180° en mitad superior para que partner lea al derecho
- [x] **PTTButton object metaphor:** disc 96 pt con tres halos concéntricos translúcidos (whisper / glow / kiss)
  - [x] Halos respiran en idle (3.2 s sine), se iluminan en press, florecen en active
  - [x] Outer ring respira cada 1.6 s cuando activo; waveform 30 pt alto, 5 barras
  - [x] Sustitución: puck-dot label → clean horizontal mic-affordance tick (14×1.5 pt) sobre language code
- [x] **Tema — palette de acentos + nuevos tokens:**
  - [x] Desaturación ligera: amber #F4B26A → #F2B473 (platinum amber), azure #7AB8FF → #86BFFF (ice blue)
  - [x] Nuevos tokens por acento: `accentAGlow`/`accentBGlow` (~0.10 opacity), `accentAWhisper`/`accentBWhisper` (~0.045)
  - [x] Nuevo `font.displayHero` (34 pt / weight 300 / -0.6 tracking) para big translated text
  - [x] Nuevos tokens: `color.fgWhisper` (0.07), `motion.glacial` (800 ms)
  - [x] Tighter `letterSpacing` en display sizes
- [x] **Polish auxiliar:**
  - [x] LanguagePairScreen: headline editorial "Dos idiomas. Una conversación." + subhead, breathing room
  - [x] SettingsScreen: header reescrito con subhead; eyebrow tracking 2.4, section labels tracking 1.8
  - [x] LanguageCard: borders ligeros (hairline), transparent empty state
  - [x] SwapButton: floating glyph, drop flanking hairlines

### Fase 6 — Polish final ✅ (Commit a34e6e7)

**Objetivo:** los detalles que separan a una app correcta de una memorable. Apoyado todo en infraestructura existente — cero dependencias nativas nuevas.

- [x] **Coreografía háptica completa** — el módulo `haptics` ya tenía pulse/tick/done/error definidos pero solo `tap` estaba cableado. Wired a las transiciones del state machine del orquestador:
  - [x] `pulse` en transiciones de pipeline (recording→transcribing, transcribing→translating)
  - [x] `tick` al primer token hablado (translating→speaking)
  - [x] `done` al cerrar el turno (terminal hook por-speaker via `useTerminalHaptic`)
  - [x] `error` en fallo
  - [x] `tick` al elegir un idioma en el LanguagePickerSheet
- [x] **Tap-to-replay** — el texto grande (y un sutil "↺ REPETIR" en la chip-row) re-pronuncia la última traducción del partner via `nativeTTSService.speakChunk`. Gated en idle (`activeTurn === null`) para que el audio nunca colisione con TTS del orquestador en vuelo. `nativeTTSService.stop()` defensivo antes de re-speak.
- [x] **Microcopy junto a StateMorph** — ESCUCHANDO / PENSANDO / HABLANDO / ERROR. Caption mono uppercase tracking 1.6. El glifo solo era ambiguo; dos palabras hacen el sistema audible.
- [x] **Reveal con `translateY`** — incoming text fade-opacity AND drift-up 6 px en la primera aparición. Driven por una transición booleana (`hasIncomingText`) en lugar de la longitud del texto, para que cada chunk de streaming no re-dispare la entrada y haga jiggle.
- [x] **Hint de primer uso** — "mantén pulsado para hablar" bajo cada disco hasta que cualquier lado complete su primer turno. Press-and-hold no es universal, especialmente para usuarios mayores que esperan tap. `firstRun = !noKey && turns.length === 0`. Desaparece para siempre tras el primer turno.
- [x] **Onboarding de la API key — Mom-tier** — la barra subió: "mi madre debe saber usar esta app".
  - [x] Primer uso: header "Bienvenido" + 3 pasos guiados en español plano. Step 1 abre `console.mistral.ai/api-keys` via `Linking.openURL`. Step 2 explica "Create new key" sin jerga. Step 3 input + botón primario "Verificar clave" + camino de éxito "Empezar a hablar →" que llama `navigation.goBack()`.
  - [x] Returning user: tarjeta compacta "Conectado a Mistral", botones COMPROBAR / CAMBIAR CLAVE.
  - [x] Banner de la conversación suavizado: "Conecta Parly con su cerebro. Te guiamos paso a paso."
  - [x] Toda la jerga eliminada: ni "API key", ni "Authorization", ni "sk-", ni "llavero".
  - [x] Secciones técnicas (limpiar historial, ver logs) ocultas en primer uso para mantener el foco del welcome.
- [x] **Picker bug fix** (sitting uncommitted): `frozenExclude` snapshot — previene que el sheet anclado al `bottom: 0` crezca de alto a mitad de la animación de cierre cuando el padre flippa `excludeCode` a undefined. La snapshot solo se actualiza mientras `visible === true`.

---

## Riesgos

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| Sin red durante conversación | Alto | `NetworkMonitor` + chip-pill, banners por turno; el orquestador falla cleanly y libera el lock |
| API key inválida o cuota agotada | Alto | `validateMistralApiKey` en settings; banner Mom-tier explica re-generar |
| Feedback loop mic / altavoz | Alto | Half-duplex estricto: el orquestador no abre el mic durante `speaking`; tail-silence 250 ms tras `tts-finish` |
| Latencia variable (cloud) | Medio | Streaming end-to-end: primer audio ~beat tras release; prewarm TLS al iniciar la app + nudge en `onFirstToken` |
| Voz OS faltante en idioma destino | Medio | El texto siempre se muestra; el pipeline no se bloquea si TTS no encuentra voz |
| WS idle drop entre turnos | Bajo | WS fresca por turno (no se mantiene abierta); TLS session reuse mantiene handshake cálido |

---

## Decisiones de diseño

- **STT y traducción cloud, TTS on-device.** Voxtral cubre 30+ idiomas con calidad superior a un whisper-small bundleable; la traducción de Mistral en streaming permite que TTS hable la primera frase mientras llega la segunda. TTS OS-nativo evita instalación de modelos.
- **Streaming end-to-end.** Voxtral WS streamea partials; Mistral SSE streamea tokens; TTS encola por frase. Primer audio ~50–150 ms tras release con TLS warm.
- **Strict half-duplex state machine.** Mic y altavoz nunca a la vez. Lock release en un único punto auditable. Hard sequential states hacen que cada code path termine demostrablemente.
- **WS fresca por turno.** Idle WS sufren timeouts opacos del servidor (30–90 s) y drops de cambio de red en mobile. TLS session reuse mantiene handshakes cálidos.
- **API key en keychain del OS.** `react-native-keychain` (iOS Keychain / Android Keystore). Solo egress a `api.mistral.ai`. Sin telemetría, sin analytics.
- **Vertical PTT axis, sin divisor, halos para profundidad.** Ver UI section. Metáfora del teléfono tumbado.
- **Onboarding Mom-tier.** Toda la jerga de API key eliminada del primer uso. Si una usuaria no técnica consigue una key con éxito, el resto de la UI ya es legible.
