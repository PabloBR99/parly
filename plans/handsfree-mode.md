# Plan de implementación — Modo Hands-Free

> Fecha: 2026-05-04
> Estado: aprobado para Phase 0
> Fuentes verificadas: docs Mistral Voxtral, HuggingFace model card, Pipecat, LiveKit plugin source, KickLLM benchmarks

## 0. TL;DR

Una conexión Voxtral persistente alimentada por VAD local (Silero), enrutamiento por idioma detectado, streaming Mistral SSE con TTS por frase, half-duplex con AEC nativo. Activado vía un toggle minúsculo en la *edge chrome* ("settings"), salida con single-tap en cualquier disco. Cinco fases de entrega, ~7-10 días de trabajo.

## 1. Objetivos / no-objetivos

**Objetivos**
- Conversación bidireccional fluida sin tocar el teléfono después de activar HF.
- Detección de fin-de-turno con latencia objetivo <800 ms (silencio percibido tras parar de hablar).
- Enrutamiento automático según idioma detectado por Voxtral, contra el par configurado.
- Convivencia con PTT: ambos modos operativos sin regresiones.
- Cero cromo nuevo visible salvo un único toggle italic-serif de 11pt.

**No-objetivos (v1)**
- Barge-in en mismo dispositivo (interrumpir TTS hablando encima). Escenario de auriculares se acepta sin tratar.
- AEC personalizado (WebRTC AEC3). Se confía en `VOICE_COMMUNICATION` (Android) que ya está activo.
- Detección de hablante (más allá del idioma). Si dos personas hablan el mismo idioma del par, se asume que es el "lado origen" del turno anterior alternado.
- Soporte de >2 idiomas en una conversación.
- Wake word ("hey Parly").

## 2. Arquitectura — cómo encaja en lo que hay

Reutilizamos al máximo. El refactor mínimo es:

```
              ┌──────────────────────────────────────────────┐
              │             ConversationOrchestrator          │
              │  ┌──────────┐  modo: ptt | hf                 │
              │  │ HF state │                                  │
              │  │ machine  │                                  │
              │  └─────┬────┘                                  │
              └────────┼──────────────────────────────────────┘
   ┌───────────┐       │       ┌──────────────────┐
   │ AudioCap  │── PCM ┼───────┤ SileroVadService │── speech_start/end
   │ (existing)│       │       └──────────────────┘
   └───────────┘       │
                       ▼
              ┌────────────────────┐
              │ VoxtralRealtime    │   modo session: WS persistente
              │   sessionMode      │   flushUtterance() en VAD-end
              │   (existing+new)   │   onLanguage / onFinal
              └────────┬───────────┘
                       │
                       ▼
              ┌────────────────────┐    ruta = lang ∈ {A,B}
              │ MistralTranslator  │    → traduce A→B o B→A
              │   (existing)       │
              └────────┬───────────┘
                       │ frases
                       ▼
              ┌────────────────────┐
              │ NativeTTSService   │
              │   (existing)       │
              └────────────────────┘
```

Cuatro decisiones arquitectónicas clave:

1. **Una sola WS Voxtral durante toda la sesión HF**, frente al patrón actual de WS-por-turno. El método `input_audio.flush` permite forzar `transcription.done` sin cerrar la conexión.
2. **Silero VAD on-device** vía `onnxruntime-react-native` consume el mismo stream PCM que ya alimenta a Voxtral. El audio sigue mandándose al servidor *en continuo* (Voxtral no espera un trigger), pero el VAD decide *cuándo* mandar `flush` y *cuándo* gatear el routing.
3. **Routing por idioma detectado** — `transcription.language` se compara contra `(personA.language, personB.language)`. Match → traducir al otro lado. Mismatch → descartar. Sin tag → fallback alternante.
4. **VAD pausado durante TTS** (mic-mute lógico, no físico — seguimos enviando PCM a Voxtral pero ignoramos sus `speech_start` durante el playback). Esto cierra el loop de auto-disparo. AEC nativo ya está mitigando el bleed real.

## 3. Stack técnico añadido

| Pieza | Paquete / fichero | Tamaño | Razón |
|---|---|---|---|
| Runtime ONNX | `onnxruntime-react-native@1.20+` | ~5 MB nativo | Ejecuta el modelo Silero |
| Modelo Silero VAD | `assets/silero_vad.onnx` | ~2 MB | DNN de detección de voz; mejor relación precisión/tamaño que WebRTC VAD |
| Long-press gesture | `react-native-gesture-handler` (ya instalado) | 0 | Tap en el toggle italic-serif del footer |

No se añade nada más. No hay servicios cloud nuevos, no hay claves nuevas.

**Plan B si Silero pesa demasiado en CMF Phone 1**: cambiar a `react-native-webrtc-vad` (wrapper sobre WebRTC VAD nativo, ~500 KB, peor accuracy pero milisegundos de CPU). Decisión a tomar tras medir en Phase 1.

## 4. Máquina de estados HF

```
┌──────────────────────────────────────────────────────┐
│                                                       │
│   ┌──────────┐      toggleHF=true    ┌────────────┐  │
│   │ ptt-idle │─────────────────────▶│ hf-idle    │  │
│   └──────────┘                       │ (mic warm, │  │
│                                      │  WS open,  │  │
│                                      │  VAD on)   │  │
│                                      └─────┬──────┘  │
│                                            │         │
│                                speech_start│         │
│                                            ▼         │
│                                      ┌────────────┐  │
│                                      │ capturing  │  │
│                                      │ (Voxtral   │  │
│                                      │  partials) │  │
│                                      └─────┬──────┘  │
│                                            │         │
│                                  speech_end│         │
│                                            ▼         │
│                                      ┌────────────┐  │
│                                      │ flushing   │  │
│                                      │ (await     │  │
│                                      │  done+lang)│  │
│                                      └─────┬──────┘  │
│                                            │         │
│                       ┌────────────────────┤         │
│                       │ lang ∈ pair        │ lang ∉  │
│                       ▼                    ▼ pair    │
│                 ┌──────────┐         (descartar,     │
│                 │translating│          → hf-idle)    │
│                 └─────┬────┘                         │
│                       │ first sentence               │
│                       ▼                              │
│                 ┌──────────┐                         │
│                 │ speaking │ (TTS playing,           │
│                 │          │  VAD gated)             │
│                 └─────┬────┘                         │
│                       │ tts complete                 │
│                       ▼                              │
│                 ┌──────────┐                         │
│                 │ cooldown │ 250 ms                  │
│                 └─────┬────┘                         │
│                       └─────▶ hf-idle                │
│                                                       │
└──────────────────────────────────────────────────────┘

Salidas globales:
- toggleHF=false (single-tap disc) → cualquier estado → cleanup → ptt-idle
- WS error                          → cualquier estado → reconnect (1 retry, ←500ms) → si falla, ptt-idle + error toast
- network offline                   → cualquier estado → ptt-idle (NetworkPill ya cubre esto)
```

**Reglas adicionales**:
- En `capturing`, si VAD silencio > 800 ms (ajustable) → `speech_end`.
- Mientras `speaking`, ignoramos eventos `speech_start` del VAD (gating).
- Hangover post-TTS = 250 ms (mismo valor que el orchestrator actual usa para PTT, ya verificado en producción).
- Si `flushing` no recibe `transcription.done` en 3 s, asumimos pérdida → reconnect WS.
- Si una utterance sale en idioma que no es ni A ni B, no se enruta. Visualmente: el bloom del lado origen se atenúa brevemente (señal silenciosa de "no entendido").

## 5. Fases de entrega

### Fase 0 — Spike de protocolo (½ día) [BLOQUEANTE]

**Objetivo:** validar que el WS Voxtral sobrevive a múltiples ciclos `audio.append → flush → done` sin desconectar.

**Entregable:** `scripts/voxtral-multiturn-spike.mjs` (Node.js, no RN) — abre WS, envía 3 utterances simuladas con WAV de prueba, verifica recibir 3 `transcription.done` y que `transcription.language` aparece en cada una. Mide latencia entre `flush` y `done` en local.

**Decisión:** si el WS se cierra después del primer `done`, plan B = WS-por-turno con TLS-cached reconnect (más latencia pero mantiene viabilidad).

### Fase 1 — Fundamentos (2-3 días)

**1.1. `VoxtralRealtimeClient` modo session**
- Nuevo flag `sessionMode: boolean` en `StreamingStartOptions`.
- Cuando `sessionMode=true`: `transcription.done` no llama a `cleanup()` — sólo emite `onFinal` y vuelve a estado "ready for next utterance".
- Nuevo método `flushUtterance(): Promise<{ text: string; language?: string }>` que envía `input_audio.flush` y resuelve con el siguiente `transcription.done` (con timeout de 3 s).
- Nuevo método `endSession()`: equivalente al actual `end()` (envía `input_audio.end`, cierra WS).
- Añadir `target_streaming_delay_ms: 480` al `session.update` inicial. Constante exportada para que se pueda ajustar.
- Añadir `transcription.segment` al parser (lo emite Voxtral, lo ignoramos hoy).

**1.2. `SileroVadService` nuevo**
- `src/services/vad/SileroVadService.ts`
- Carga `silero_vad.onnx` desde `assets/`, mantiene tensor de estado RNN.
- API: `feedFrame(pcmInt16: Int16Array)` (frame de 512 muestras a 16 kHz = 32 ms), `subscribe(onSpeechStart, onSpeechEnd)`, `setActive(bool)` para gating.
- Hangover configurable (`silenceHangoverMs`, default 800).
- Threshold configurable (`speechProbThreshold`, default 0.5).
- Worklet de Reanimated para correr en JS thread sin bloquear UI; alternativa: módulo nativo si la latencia inferiora 32 ms es problema.

**1.3. Tests**
- `VoxtralRealtimeClient.test.ts`: añade casos para `sessionMode` (3 utterances back-to-back con WS mock), `flushUtterance()` resolution, timeout en `flush`.
- `SileroVadService.test.ts`: alimentar PCM grabado conocido (silencio, voz, mezcla), verificar callbacks. WAV fixtures pequeños en `__fixtures__/`.

### Fase 2 — Pipeline (1-2 días)

**2.1. `ConversationOrchestrator` modo HF**
- Nuevo método `enableHandsFree(): Promise<void>` y `disableHandsFree(): Promise<void>`.
- Internamente añade un `mode: 'ptt' | 'hf'` y lleva un `hfState: HfStateMachine`.
- En `enableHandsFree`:
  1. Inicia VAD service.
  2. Inicia audio capture si no está.
  3. Abre Voxtral en `sessionMode=true`.
  4. Suscribe VAD: `onSpeechStart` → comienza nueva turn (idle → capturing); `onSpeechEnd` → llama a `flushUtterance()` → llega `{text, language}`.
  5. En `onLanguage` recibido (o `language` en `onFinal`): match contra `(personA.language, personB.language)`.
- Routing decision:
  - `language` ∈ {A.code, B.code} → `sourceLang = matched`, `targetLang = other`.
  - Sin match: descartar utterance, callback `onUnroutedUtterance(text, lang)` para visual feedback.
  - Sin language tag: usar idioma del último turn distinto al actual (alternancia); si es el primer turn, usar A.
- Reusa `dispatchTranslation()` actual para el resto del pipeline (Mistral SSE → TTS por frase). Cambia el comportamiento al final: en lugar de `completeTurn` y volver a `idle`, vuelve a `hfState=hf-idle` y deja la WS abierta.
- Mientras `speaking`, llama a `vad.setActive(false)` para gating.

**2.2. `conversationStore` extendido**
- Nuevo campo `mode: 'ptt' | 'hf'` (default 'ptt').
- Nuevo campo `hfActiveSpeaker: PersonId | null` (qué lado está siendo enrutado).
- Acciones: `setMode(mode)`, `setHfActiveSpeaker(id | null)`.

**2.3. Tests**
- `ConversationOrchestrator.test.ts`: añade casos HF con mocks de VAD y Voxtral session-mode. Verifica:
  - Routing correcto A→B y B→A.
  - Descarte cuando lang ∉ pair.
  - Fallback alternante cuando no hay tag.
  - VAD gated durante TTS.
  - Salida limpia con `disableHandsFree()` desde cualquier estado.

### Fase 3 — UI (2-3 días)

**3.1. Toggle de activación**
- En `ConversationScreen`, junto a "settings" (lado del usuario), añadir un texto italic-serif de 11pt: `hands-free` (lowercase, mismo `tone="fgFaint"` que "settings", separador `· ` o vertical hairline).
- Tap → llama a `orchestrator.enableHandsFree()` o `disableHandsFree()` según estado.
- Cuando HF activo: el texto se vuelve `tone="fgMuted"` y antepone un punto luminoso de 4 px en blanco con `box-shadow` glow de 3 px (mismo lenguaje que `NetworkPill`).
- Sólo visible cuando `apiKey && !noKey && languages elegidos`.

**3.2. `PTTButton` extendido**

> **⚠ CORRECCIÓN DE DISEÑO (redesign "Voz", reemplaza lo de abajo).** En HF no
> sabemos quién habla hasta transcribir y detectar el idioma, así que los discos
> **no** reaccionan por lado. Se eliminaron `hf-source-active` y
> `hf-target-speaking`. Con HF activo ambos discos se quedan en su aspecto neutro
> de reposo (vidrio + tick + código de idioma), bloom recesivo al 30%, sin ring,
> sin waveform, sin shimmer ni punto pulsante. El **único** elemento vivo en HF
> es la onda de voz de la costura (`SeamControl`). `DiscMode` queda en
> `ptt-idle | ptt-active | hf-idle`. El pulso direccional del `SeamShimmer`
> (§3.3) se mantiene: se dispara *después* de enrutar, cuando la dirección sí se
> conoce.

- Nuevo prop `mode: DiscMode`:
  ```ts
  type DiscMode =
    | { kind: 'ptt-idle' }
    | { kind: 'ptt-active' }
    | { kind: 'hf-idle' };  // ambos discos en este modo, neutros, cuando HF on
  ```
- Nuevo prop `onTap` (single-tap) — usado para salir de HF.
- Comportamiento visual:
  - `ptt-*`: idéntico al actual.
  - `hf-idle`: aspecto de reposo neutro (tick + código de idioma), bloom recesivo al 30%, sin animación por lado.
- Animación `discInhale`: una respiración (scale 1.0 → 1.08 → 1.0, ease in-out) que se dispara una vez al activar HF — confirmación física de la entrada en modo (transición de una sola pasada, no un elemento "vivo" persistente).

**3.3. `SeamShimmer` direccional (nuevo componente)**
- `src/ui/animations/SeamShimmer.tsx`
- Reemplaza el `seam` decorativo actual (manteniendo el shimmer base que ya existe en el `DuskBackdrop`).
- Reanimated SharedValue `pulseDirection: 0 | 1 | -1` (0=idle, 1=top→bottom, -1=bottom→top).
- Cuando `pulseDirection !== 0`: gradient mask viaja a lo largo del seam ~400 ms con opacity peak 0.18, después vuelve a 0. Color blanco puro (la traducción siempre es blanca, así que el "tránsito" también).
- Disparo: el orchestrator notifica al store `setHfActiveSpeaker(targetId)` cuando empieza la traducción; un hook en `ConversationScreen` deriva la dirección y trigger.

**3.4. Estado "primer uso" de HF**
- Cuando se activa HF por primera vez, mostrar un *welcome card* análogo al actual (`Press and hold to speak.`) pero con copy: `Just speak. Tap any disc to exit.` — desaparece tras la primera utterance enrutada.

### Fase 4 — Polish (1 día)

- Ajuste fino del hangover de VAD (probar 600/800/1000 ms en CMF Phone 1).
- Telemetría: log de cada turn HF con timings (VAD-end → flush, flush → done, done → first-token, first-token → first-tts-start).
- Manejo de `network-offline` mientras HF activo: mostrar microcopy en la chrome ("hands-free paused — offline"), pausar VAD, reanudar al volver online.
- Permisos: confirmar que el flujo de permisos de mic no se dispara al activar HF si ya estaba concedido.
- Revisar comportamiento al volver de background: si Android pausó el WS, reconectar antes de aceptar la primera utterance.

## 6. Cambios fichero a fichero

### Nuevos

| Fichero | Propósito |
|---|---|
| `src/services/vad/SileroVadService.ts` | Servicio VAD basado en ONNX |
| `src/services/vad/__tests__/SileroVadService.test.ts` | Tests unitarios con WAV fixtures |
| `src/services/vad/__fixtures__/silence.wav`, `voice.wav`, `mixed.wav` | Audio de prueba |
| `assets/silero_vad.onnx` | Modelo ONNX (≈2 MB) |
| `src/ui/animations/SeamShimmer.tsx` | Pulso direccional del seam |
| `scripts/voxtral-multiturn-spike.mjs` | Spike de Phase 0, no se mantiene en producción |

### Modificados

| Fichero | Cambio |
|---|---|
| `src/services/stt/VoxtralRealtimeClient.ts` | `sessionMode`, `flushUtterance()`, `endSession()`, `target_streaming_delay_ms` en session.update |
| `src/services/stt/__tests__/VoxtralRealtimeClient.test.ts` | Casos session-mode |
| `src/services/pipeline/ConversationOrchestrator.ts` | `enableHandsFree()`, `disableHandsFree()`, HF state machine, routing por idioma |
| `src/services/pipeline/__tests__/ConversationOrchestrator.test.ts` | Casos HF |
| `src/services/pipeline/orchestrator.ts` | Inyectar `SileroVadService` y conversation store flags |
| `src/store/conversationStore.ts` | `mode`, `hfActiveSpeaker`, acciones |
| `src/ui/primitives/PTTButton.tsx` | Prop `mode: DiscMode`, prop `onTap`, animaciones HF |
| `src/ui/animations/Bloom.tsx` | Aceptar prop `intensity: number` (0-1) para escalar opacidad |
| `src/screens/conversation/SpeakerHalf.tsx` | Pasar `mode` a `PTTButton`, derivarlo de `activeTurn` + `mode` del store |
| `src/screens/ConversationScreen.tsx` | Toggle HF en edge chrome; suscribir cambios de `hfActiveSpeaker` para SeamShimmer |
| `package.json` | `+onnxruntime-react-native` |
| `android/app/build.gradle` | Si onnxruntime requiere config nativo (probable: nada, sólo añadir dep) |

### Sin cambios

- `MistralTranslator.ts` — el streaming-TTS ya funciona, no toca.
- `NativeTTSService.ts` — la cola y el prewarm sirven igual.
- `AudioCaptureService.ts` — ya hace streaming PCM. Sólo se añade un consumer (VAD) en paralelo a Voxtral.
- `DuskBackdrop`, `LanguagePickerSheet`, `NetworkPill`, `StateMorph` — intactos.
- Theme tokens (`color`, `font`, `motion`) — intactos.

## 7. Diseño visual detallado

### Toggle (footer del usuario)

```
                                                ·  hands-free
                  settings
                                              ↑ punto luminoso
                                                cuando activo
                                                (4px, blanco,
                                                 glow 3px)
```

- Italic-serif, 11pt, `tone="fgFaint"` cuando off, `tone="fgMuted"` cuando on.
- Hairline divisor opcional (`borderLeft: 1px hairline`) — decidir tras prototipar.
- Estado primer uso: si nunca se ha activado, prefijar un punto pulsante muy tenue para invitarlo. Tras primer uso, queda estático.

### Disco — modo `hf-idle` (único modo de disco en HF)

- Bloom: opacity multiplicada por 0.30, mismo período de respiración — recesivo.
- Tick (línea horizontal): **se mantiene** el tick neutro de reposo. (Corrección: el punto pulsante anterior se eliminó — el único elemento vivo en HF es la onda de la costura.)
- Lang label: opacidad 45% — "atento, no protagonista".

### Discos en HF — sin reacción por lado (corrección de diseño)

Los modos `hf-source-active` y `hf-target-speaking` se eliminaron. En HF no se
conoce el hablante en tiempo real, así que ningún disco anima por lado: ambos
mantienen `hf-idle`. La señal de captura/salida vive en la onda de la costura
(`SeamControl`: onda viva al escuchar, oscilación calmada al traducir) y, para la
dirección ya conocida tras enrutar, en el pulso del `SeamShimmer`.

### SeamShimmer pulso direccional

- Trigger: `setHfActiveSpeaker('person_b')` con previa `'person_a'` → pulso bottom→top.
- Duración total: 400 ms.
- Curva: linear-gradient mask animado a lo largo del eje Y del seam (height 80px del actual seam).
- Peak opacity: 0.18 (seam idle es 0.07).
- Tras el pulso: vuelve al shimmer estático actual.
- Si el routing falla (lang ∉ pair): NO se dispara el shimmer. En su lugar, el bloom del lado origen baja a 15% durante 600 ms y vuelve. Señal silenciosa de "no enrutado".

### Animación `discInhale` (entrada a HF)

- Scale 1.0 → 1.08 → 1.0, easing in-out, 700 ms.
- Aplica a *ambos* discos simultáneamente.
- Acompañada por una atenuación del `vignette` (radial outer del backdrop) durante el mismo intervalo: peak opacity -10% sobre baseline, vuelve. Lectura: "el ambiente respira con el dispositivo".

## 8. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Voxtral cierra WS tras primer `transcription.done` (no soporta multi-turn) | Media | Alto — cambia toda la arquitectura | Phase 0 spike valida antes de tocar producción. Plan B: WS-por-turno con TLS-cached reconnect, latencia +150 ms |
| Idle disconnect del WS (30-90 s sin actividad) | Alta | Medio — pausa breve la primera utterance tras silencio largo | Reconectar transparentemente al detectar `onclose`; latencia recuperable <500 ms; aceptable porque sólo ocurre tras pausas largas |
| Silero VAD demasiado pesado en CMF Phone 1 | Media | Medio | Plan B WebRTC VAD nativo; o gating temporal del VAD (correr 1 frame de cada 2) |
| Auto-disparo (TTS bleed → mic) | Baja-Media | Alto si ocurre | AEC nativo + VAD pausado durante TTS + cooldown 250 ms. Test empírico es bloqueante. Si falla: subir threshold de VAD a 0.7 durante TTS |
| Idioma detectado erróneamente (ej. español confundido con italiano) | Media | Medio — descarte falso o routing incorrecto | El modelo Voxtral en su benchmark FLEURS tiene 8.7% WER medio; LID es típicamente más fiable. Mostrar feedback visual de descarte para que el usuario pueda repetir |
| Battery drain por mic abierto continuamente | Baja | Bajo | Audio source = `VOICE_COMMUNICATION` (más eficiente que MIC raw); WS abierto consume <50 mA en idle; aceptable |
| Reconexión de red durante HF activo | Media | Medio | NetworkPill ya detecta esto; HF entra en pausa con microcopy; reanudación al volver |
| Long-press accidental confundido con tap (en modo HF para salir) | Baja | Bajo | El single-tap dispara `onTap` antes de `onLongPress` (delayLongPress=600). Conflicto resuelto por gesture handler |

## 9. Plan de pruebas

**Unit (Jest)**
- VAD: silencio puro, voz limpia, voz con ruido, transición voz→silencio (verificar hangover).
- Voxtral session-mode: 3 utterances back-to-back con WebSocket mock, verificar 3 `onFinal`.
- Orchestrator HF: routing A→B y B→A; descarte por idioma; fallback alternante; VAD gated durante TTS; cleanup completo en `disableHandsFree`.

**Integración (sin TTS real, sin Voxtral real)**
- `HandsFreeIntegration.test.ts` (nuevo): orchestrator + VAD service real + Voxtral mock + Mistral mock + TTS mock. Reproduce un PCM grabado de "hola, ¿qué tal?" y verifica el pipeline completo.

**Manual / device**
- En CMF Phone 1: HF activo, decir "Good morning" en EN → debería oírse "Buenos días" en ES con latencia <2s desde fin de palabra. Repetir con "¿Cómo estás?" en ES → "How are you?" en EN.
- Auto-loop test: activar HF, dejar el dispositivo solo durante 60 s, verificar que NO se dispara ningún turn (TTS/altavoz no debe gatillarse a sí mismo).
- Salida: single-tap durante TTS, durante captura, durante translating — verificar cleanup limpio.
- Network drop: activar avión a mitad de un turno HF, verificar pausa elegante.

**E2E (Playwright/RN test runner)**
- Activación de HF desde toggle, verificar render de los discos en estado `hf-idle`, dispatch de un audio simulado al pipeline, verificar que aparece la traducción en el lado correcto y que los discos transitan por los modos correctos.

## 10. Kill-switch / rollback

- **Flag global**: `HANDS_FREE_ENABLED` constante en `src/app/featureFlags.ts`. A `false` esconde el toggle por completo y no carga `SileroVadService`.
- **Per-API-key fallback**: si `enableHandsFree` falla (Voxtral no soporta session, ONNX no carga, etc.), captura el error, deshabilita el toggle hasta el próximo restart, log claro al usuario.
- **Rollback de versión**: el modo HF está confinado a (a) `VoxtralRealtimeClient` modo nuevo opcional (sessionMode default false), (b) un nuevo servicio aislado, (c) un nuevo método del orchestrator. PTT funciona sin tocar nada de eso. Revertir HF = quitar las dos llamadas en `ConversationScreen` y la prop `mode` del PTTButton.

## 11. Telemetría

Por cada turn HF, log estructurado en `logStore` con:

```ts
{
  kind: 'hf_turn',
  vadEndToFlush: number,         // ms, sanity check del flush propio
  flushToFinal: number,          // ms, latencia Voxtral
  finalToFirstToken: number,     // ms, TTFT Mistral
  firstTokenToFirstTtsStart: number,
  totalTurnDuration: number,
  routedLanguage: string | null,
  configuredPair: [string, string],
  routingResult: 'matched' | 'mismatched' | 'fallback',
  utteranceWordCount: number,
}
```

Después de 1 semana de uso, revisar `mismatched` rate. Si >5% de turns fallan en routing, considerar usar Mistral chat completion como segundo opinion para LID en utterances cortas (<5 palabras).

## 12. Métricas de éxito

- **Latencia perceived**: P50 <1.4 s, P95 <2.2 s desde fin de palabra hasta primer audio del TTS.
- **Auto-disparo**: 0 turns HF gatillados sin voz humana presente, en sesiones de prueba de 5 min.
- **Routing accuracy**: ≥95% de utterances en idioma del par correctamente enrutadas.
- **Battery**: <5% de drain extra por hora vs PTT (medido en CMF Phone 1).
- **Estética**: cero comentarios de "se ve diferente / se siente como otra app". El modo debe sentirse como una capa adicional del mismo objeto, no como una sección distinta.

---

## Apéndice A — Findings de la investigación previa

Verificado vía docs Mistral, HuggingFace, Pipecat y LiveKit:

- **Voxtral NO tiene endpointing en servidor.** Cliente debe usar VAD local. Silero es la elección estándar.
- **`input_audio.flush` mantiene el WS abierto.** Permite multi-turn en una sola conexión. (Verificable en Phase 0).
- **`transcription.language` event existe** y ya está cableado en `VoxtralRealtimeClient.ts:208-211`. Campo `language`. Sólo el orchestrator descarta el valor hoy.
- **`target_streaming_delay_ms` configurable** (240–2400 ms, *sweet spot* 480 ms). Hoy no lo enviamos en `session.update`.
- **Mistral Small TTFT**: ~310–680 ms US-East, +80–110 ms desde EU → ~400–700 ms desde España. Throughput 105–137 tok/s.
- **Android `VOICE_COMMUNICATION`** ya activa AEC + AGC + NS (`AudioCaptureService.ts:23`) — base sólida para half-duplex sin AEC custom.

## Apéndice B — Presupuesto de latencia (turn HF típico)

| Etapa | ms (mín-máx) |
|---|---|
| Hangover Silero VAD tras silencio | 300–600 |
| `flush` → `transcription.done` | 200–500 |
| TTFT Mistral SSE (España → EU) | 400–700 |
| Acumular hasta 1.ª frase emitible | 100–300 |
| TTS primer frame (Android, prewarmed) | 100–300 |
| **Total "fin de palabra → suena traducción"** | **~1.1 – 2.4 s** |

El streaming-TTS por frase ahorra 1–2 s frente a esperar la traducción completa.
