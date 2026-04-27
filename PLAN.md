# Parly — Real-Time Conversation Translator

App móvil cross-platform (iOS + Android) que traduce conversaciones cara a cara en tiempo real. El teléfono se coloca entre dos personas. Pantalla dividida: cada persona ve la conversación en su idioma. 100% on-device, sin cloud.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| UI | React Native 0.84 (bare) + TypeScript |
| Animaciones | react-native-reanimated |
| Estado | Zustand (inmutable) |
| STT | whisper.rn (whisper-small multilingual, ~350MB) |
| Traducción | iOS Translation framework / Android ML Kit (OS-native, 0MB extra) |
| TTS | ZipVoice distill-int8 via react-native-sherpa-onnx (~104MB ONNX) |
| Voces | Voice cloning zero-shot: usa el propio audio PTT del hablante como referencia |
| Fallback TTS | AVSpeechSynthesizer (iOS) / Android TTS si RAM < 1GB libre |

**Memoria estimada:** ~800MB pico (Whisper 350MB + ZipVoice ~400MB pico + overhead)  
**Dispositivo mínimo recomendado:** 4GB RAM

> **Spike result (2026-04-03):** Voxtral-4B-TTS via llama.rn descartado — llama.rn no tiene API TTS output, el codec VQ-FSQ de Voxtral no existe en llama.cpp, y no hay GGUF oficial. ZipVoice elegido: 104MB, ONNX, voice cloning zero-shot, package RN disponible.

---

## Arquitectura del pipeline

```
Persona habla (PTT o VAD)
       ↓
AudioCaptureService — PCM 16kHz mono
       ↓
WhisperService — transcripción en idioma origen
       ↓  ↘
       │   resample 16kHz→24kHz + trim a 5s  ←── referencia de voz
       ↓
TranslationService — texto traducido al idioma destino
       ↓
ZipVoiceService(
  text:          texto traducido,
  referenceAudio: buffer 24kHz del hablante (max 5s),
  referenceText:  transcripción de Whisper
) — síntesis en la voz del hablante
       ↓
AudioPlayerService — reproducción por altavoz
```

Todo secuencial via `UtteranceQueue`. Una utterance a la vez.  
**Primera utterance de cada persona:** fallback a OS TTS (sin referencia previa aún).

---

## UI — Vertical PTT Layout (Redesign v5, a43525e)

**Concepto:** El teléfono está tumbado sobre la mesa entre dos personas. Cada persona tiene su botón PTT en su EXTREMO FÍSICO del dispositivo — partner arriba (rotado), user abajo — así el pulgar cae naturalmente. El texto traducido se inclina hacia el centro, donde ocurre la conversación real. **No hay divisor hairline** — el silencio entre las dos líneas fuente ES el seam.

**Layout de `SpeakerHalf` (top-down, orden de lectura):**
1. Source line — texto capturado MIENTRAS habla, o fuente del partner post-turn (pequeño, near center)
2. Big translated text — `displayHero` (34pt, weight 300, -0.6 tracking) — QUÉ LEE ESTA PERSONA
3. Identity chip — language endonym + state morph (grabando/transcribiendo/traduciendo/sintetizando)
4. PTT button — object metaphor con halos concéntricos translúcidos
5. Edge chrome — online/offline pill (partner) o "ajustes" link (user)

**PTTButton object metaphor:**
- Disc 96pt con tres halos concéntricos que respiran en idle (3.2s sine), se iluminan en press
- Activo: outer ring respira cada 1.6s; waveform 30pt tall, 5 barras
- Label: clean horizontal mic-affordance tick (14×1.5pt line) sobre language code (antes: puck-dot)
- Accents: platinum amber #F2B473 ("you") / ice blue #86BFFF ("them")
- Halos por acento: `accentGlow` (~0.10 opacity), `accentWhisper` (~0.045), `accentRing` (0.55)

**Theme tokens nuevos:**
- `color.accentAGlow`, `color.accentBGlow`, `color.accentAWhisper`, `color.accentBWhisper`
- `color.fgWhisper` (0.07 opacity) — nueva tier de foreground
- `font.displayHero` (34pt, weight 300, -0.6 tracking) — main translated text
- `motion.glacial` (800ms) — slow breath animation

---

## Estructura del proyecto

```
parly/
├── src/
│   ├── app/
│   │   └── types.ts                    # Tipos globales
│   ├── store/
│   │   ├── conversationStore.ts        # Mensajes, hablante activo
│   │   ├── settingsStore.ts            # Idiomas, voces
│   │   └── modelStore.ts              # Estado de carga de modelos
│   ├── services/
│   │   ├── pipeline/
│   │   │   ├── PipelineOrchestrator.ts
│   │   │   └── UtteranceQueue.ts
│   │   ├── stt/
│   │   │   └── WhisperService.ts
│   │   ├── translation/
│   │   │   ├── TranslationService.ts       # Interfaz común
│   │   │   ├── TranslationService.ios.ts   # iOS Translation framework
│   │   │   └── TranslationService.android.ts # Android ML Kit
│   │   ├── tts/
│   │   │   ├── ZipVoiceService.ts          # TTS principal (react-native-sherpa-onnx)
│   │   │   ├── NativeTTSService.ts         # Fallback OS TTS
│   │   │   └── AudioPlayerService.ts
│   │   ├── audio/
│   │   │   ├── AudioCaptureService.ts
│   │   │   └── VADService.ts
│   │   ├── models/
│   │   │   └── ModelManager.ts
│   │   └── memory/
│   │       └── MemoryMonitor.ts
│   ├── components/
│   │   ├── conversation/
│   │   │   ├── SplitScreenLayout.tsx
│   │   │   ├── PersonPanel.tsx
│   │   │   ├── ChatBubble.tsx
│   │   │   ├── ChatBubbleList.tsx
│   │   │   ├── LanguageSelector.tsx
│   │   │   ├── SpeakButton.tsx
│   │   │   └── StatusIndicator.tsx
│   │   └── shared/
│   │       ├── LoadingOverlay.tsx
│   │       └── ProgressBar.tsx
│   └── screens/
│       ├── ConversationScreen.tsx
│       ├── SetupScreen.tsx
│       └── ModelDownloadScreen.tsx
├── ios/
│   └── Parly/
│       ├── Translation/
│       │   └── TranslationBridge.swift
│       └── Audio/
│           └── AudioRouterBridge.swift
└── android/
    └── app/src/main/java/com/parly/
        ├── translation/
        │   └── TranslationModule.kt
        └── audio/
            └── AudioRouterModule.kt
```

---

## Fases

### Fase 0 — Spike (validar antes de construir)
- [x] ~~Voxtral Q4 GGUF via llama.rn~~ — **DESCARTADO** (2026-04-03): llama.rn sin API TTS output, codec VQ-FSQ sin implementar
- [x] TTS alternativo evaluado: **ZipVoice distill-int8** via `react-native-sherpa-onnx` — VIABLE
- [ ] Whisper small transcribe en <3s en dispositivo real
- [ ] ZipVoice + Whisper caben en memoria simultáneamente (~800MB pico estimado)
- [ ] Voice cloning funciona usando el propio audio PTT como referencia (resample 16→24kHz, trim 5s)
- **Fallback TTS:** AVSpeechSynthesizer (iOS) / Android TTS si RAM < 1GB libre

### Fase 1 — Shell + PTT + STT ✅
- [x] React Native project inicializado
- [ ] Split-screen con rotación 180°
- [ ] Grabación PTT → Whisper STT → texto en panel del hablante

### Fase 2 — Traducción ✅
- [x] iOS Translation bridge (Swift) — `TranslationBridge.swift` + `TranslationBridge.m`
- [x] Android ML Kit bridge (Kotlin) — `TranslationModule.kt` + `TranslationPackage.kt`
- [x] Texto traducido aparece en panel del oyente — via conversationStore → ChatBubbleList
- [x] PipelineOrchestrator conectando STT → Translation
- ⚠️ iOS: `TranslationSession(configuration:)` standalone = iOS 18+. En iOS 17.4 puede requerir ajuste al bridge Swift.

### Fase 3 — TTS ZipVoice ✅
- [x] `react-native-sherpa-onnx@0.3.0` instalado — AARs precompilados via Gradle
- [x] Modelo `sherpa-onnx-zipvoice-distill-int8-zh-en-emilia` (~104MB) — descarga en primer arranque
- [x] `ZipVoiceService.ts` — API real `createTTS` / `TtsEngine` de `react-native-sherpa-onnx/tts`
- [x] `src/utils/audioUtils.ts` — `readWavAsVoiceRef`: decode WAV Int16 → Float32, resample 16→24kHz, trim 5s
- [x] `PipelineOrchestrator` — `readWavAsVoiceRef(audioPath)` → `zipvoiceService.synthesize` → `audioPlayerService.play`
- [x] Fallback automático a `NativeTTSService` si ZipVoice no disponible o falla
- [x] `numSteps: 5` (balance velocidad/calidad)
- [x] Probado en Android ✓

### Fase 4 — VAD + Polish ✅
- [x] Voice Activity Detection (energy-based) — VADService + VADController + WavWriter
- [x] Indicadores de estado animados — StatusIndicator con dot pulsante por stage
- [x] Manejo de errores completo — bubbles rojas en error, fallback NativeTTS
- [x] SettingsScreen — autoPlay toggle, ttsNumSteps (5/10/15/20), borrar conversación
- [x] Navegación Settings desde ConversationScreen (botón ⚙ en el divisor)

### Fase 5 — UI Redesign ✅ (Commit a43525e)
- [x] **Vertical PTT axis:** Botón PTT en cada EXTREMO FÍSICO del teléfono (partner arriba, user abajo)
  - [x] Sin divisor central de hairline — el silencio entre dos líneas fuente ES el divisor
  - [x] Layout de lectura en `SpeakerHalf`: fuente → texto grande → chip identidad → PTT → edge chrome
  - [x] Rotación 180° en mitad superior para que partner lea al derecho
- [x] **PTTButton object metaphor:** disc 96pt con tres halos concéntricos translúcidos (whisper / glow / kiss)
  - [x] Halos respiran en idle (3.2s sine), se iluminan en press, florecen en active
  - [x] Outer ring respira cada 1.6s cuando activo; waveform 30pt alto, 5 barras
  - [x] Sustitución: puck-dot label → clean horizontal mic-affordance tick (14×1.5pt) sobre language code
- [x] **Tema — palette de acentos + nuevos tokens:**
  - [x] Desaturación ligera: amber #F4B26A → #F2B473 (platinum amber), azure #7AB8FF → #86BFFF (ice blue)
  - [x] Nuevos tokens por acento: `accentAGlow`/`accentBGlow` (~0.10 opacity), `accentAWhisper`/`accentBWhisper` (~0.045)
  - [x] Nuevo `font.displayHero` (34pt / weight 300 / -0.6 tracking) para big translated text
  - [x] Nuevos tokens: `color.fgWhisper` (0.07), `motion.glacial` (800ms)
  - [x] Tighter `letterSpacing` en display sizes
- [x] **Polish auxiliar:**
  - [x] LanguagePairScreen: headline editorial "Dos idiomas. Una conversación." + subhead, breathing room
  - [x] SettingsScreen: header reescrito con subhead; eyebrow tracking 2.4, section labels tracking 1.8
  - [x] LanguageCard: borders ligeros (hairline), transparent empty state
  - [x] SwapButton: floating glyph, drop flanking hairlines

---

## Riesgos

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| ~~Voxtral no soportado por llama.cpp~~ | ~~Crítico~~ | **RESUELTO**: reemplazado por ZipVoice |
| OOM en dispositivos 4GB | Alto | Lite mode automático |
| Feedback loop mic/altavoz | Alto | Half-duplex: pausa grabación durante TTS |
| VAD activa hablante incorrecto | Medio | Default PTT; VAD requiere tap para reclamar |

---

## Decisiones de diseño

- **TTS:** ZipVoice distill-int8 via sherpa-onnx. Voice cloning zero-shot sin setup: cada utterance PTT sirve como referencia para la síntesis siguiente. La voz del TTS ES la voz real del hablante.
- **Referencia de voz:** el buffer PTT capturado, resampleado 16kHz→24kHz y recortado a 5s. No se persiste en disco — se pasa directamente en memoria al pipeline. Primera utterance usa OS TTS fallback.
- **numSteps TTS:** 5 por defecto (tiempo real ~0.5s en dispositivo moderno). Ajustable 5-20 en settings para calidad.
- **Traducción:** OS-native por eficiencia de memoria (0MB extra vs ~300MB de NLLB)
- **Sin cloud:** Conversaciones y audio nunca salen del dispositivo.
- **Half-duplex:** Una persona habla a la vez — evita feedback y simplifica el pipeline
- **Sin cloud:** Conversaciones nunca salen del dispositivo
