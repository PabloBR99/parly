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

## UI

- Pantalla dividida en dos mitades iguales
- Mitad inferior rotada 180° (la otra persona lee desde el otro lado de la mesa)
- Cada mitad: selector de idioma (bandera) + burbujas de chat + botón PTT
- Burbujas: texto original en panel del hablante, texto traducido en panel del oyente
- Indicador de estado: grabando / transcribiendo / traduciendo / sintetizando

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
