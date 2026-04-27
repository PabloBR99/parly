# Parly — Real-Time Conversation Translator

Audio-first bidirectional speech translation app. React Native (bare) for iOS + Android. Phone laid flat between two speakers; each half of the screen is rotated 180° so both people read upright from their side of the table. 100% on-device, no cloud.

---

## Quick Start

```bash
# Install dependencies
npm install

# Start Metro bundler
npm start

# In another terminal, run on device/simulator
npm run android    # or
npm run ios
```

For first-time iOS setup:
```bash
cd ios
bundle install
bundle exec pod install
cd ..
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| **UI** | React Native 0.84 (bare) + TypeScript, reanimated |
| **State** | Zustand (immutable) |
| **STT** | whisper.rn (whisper-small multilingual, ~350MB) |
| **Translation** | iOS Translation framework / Android ML Kit (0MB extra, OS-native) |
| **TTS** | ZipVoice distill-int8 via react-native-sherpa-onnx (~104MB ONNX), voice cloning zero-shot |
| **Fallback TTS** | AVSpeechSynthesizer (iOS) / Android TTS if RAM < 1GB free |

**Estimated peak memory:** ~800MB (Whisper 350MB + ZipVoice ~400MB peak + overhead)  
**Minimum device:** 4GB RAM recommended

---

## Architecture

```
Person speaks (PTT or VAD)
       ↓
AudioCaptureService — PCM 16kHz mono
       ↓
WhisperService — transcription (source language)
       ↓  ↘
       │   resample 16→24kHz + trim to 5s  ←── voice reference
       ↓
TranslationService — translated text (target language)
       ↓
ZipVoiceService(
  text:          translated text,
  referenceAudio: 24kHz buffer of speaker (max 5s),
  referenceText:  Whisper transcription
) — synthesis in speaker's voice
       ↓
AudioPlayerService — playback
```

Sequential via `UtteranceQueue` (one utterance at a time, half-duplex).  
**First utterance per speaker:** falls back to OS TTS (no voice reference yet).

---

## UI — Vertical PTT Layout

**Design Language:** Editorial dark, restrained palette. Two quiet accents: **platinum amber** (#F2B473, "you") and **ice blue** (#86BFFF, "them"). Depth on black via translucent halos, not shadows.

**Concept:** Phone lies flat between two speakers. Each person's PTT sits at THEIR PHYSICAL EDGE of the device — partner's at top (rotated), user's at bottom — so thumbs land naturally. **No center hairline divider**; the silence between the two source lines IS the seam.

```
┌─────────────────────────────┐
│   ●  online                 │  ← partner's edge chrome
│                             │
│           ◯                 │  ← partner's PTT (rotated 180°)
│                             │
│   español  ▾                │  ← identity chip: language + state morph
│                             │
│   Lo que el usuario         │  ← big translated text (hero display)
│   acaba de decir            │
│                             │
│   — fuente —                │  ← source line (small, near center)
│                             │
│           (gap)             │  ← PURE SPACE — no divider line
│                             │
│   — fuente —                │
│                             │
│   What the partner          │  ← big translated text
│   just said                 │
│                             │
│   english  ▾                │  ← identity chip
│                             │
│           ◯                 │  ← user's PTT
│                             │
│   ⌘  ajustes                │  ← user's edge chrome (settings)
└─────────────────────────────┘
```

**Each `SpeakerHalf` structure (top-down, reading order):**
1. **Source line** — text captured WHILE speaking, or partner's source after turn completes (small, near-center)
2. **Big translated text** — `displayHero` (34pt, weight 300, -0.6 tracking) — WHAT THIS PERSON READS
3. **Identity chip** — language endonym + state morph (recording / transcribing / translating / synthesizing)
4. **PTT button** — object metaphor with concentric halos
5. **Edge chrome** — online/offline pill (partner) or "ajustes" link (user)

**PTTButton — Object Metaphor:**
- **96pt disc** with three concentric translucent halos (whisper / glow / kiss)
- At rest: halos breathe (3.2s sine), faint presence
- On press: halos brighten, disc scales slightly
- Active: outer ring breathes outward (1.6s), delicate waveform inside (30pt tall, 5 bars)
- Label: clean horizontal mic-affordance **tick** (14×1.5pt line) above language code (replaces old puck-dot)
- Colors per speaker: `accent`, `accentRing` (bright ring), `accentGlow` (~0.10 opacity, mid halo), `accentWhisper` (~0.045, far-field)

**Theme — New Tokens (v5 redesign, commit a43525e):**

Accent palette slightly desaturated:
- **Person A (user):** platinum amber #F2B473 (was #F4B26A)
- **Person B (partner):** ice blue #86BFFF (was #7AB8FF)

Per-accent halo tokens:
```
accentAGlow: rgba(242,180,115,0.10)      // ~10% opacity
accentAWhisper: rgba(242,180,115,0.045)  // ~4.5% opacity
accentBGlow: rgba(134,191,255,0.10)
accentBWhisper: rgba(134,191,255,0.045)
```

New foreground tier: `fgWhisper` (0.07 opacity) — ultra-subtle text.

New display role: `displayHero` — main translated text (34pt, weight 300, -0.6 tracking).

New motion timing: `motion.glacial` (800ms) — slow breath animations.

---

## Project Structure

```
parly/
├── src/
│   ├── app/
│   │   └── languages.ts        # Language metadata (endonym, flags)
│   │   └── types.ts            # Global types
│   ├── store/
│   │   ├── conversationStore.ts # Messages, active speaker
│   │   ├── settingsStore.ts    # Languages, API key
│   │   ├── networkStore.ts     # Online/offline state
│   │   └── modelStore.ts       # Model loading state
│   ├── services/
│   │   ├── pipeline/
│   │   │   ├── orchestrator.ts  # Main pipeline: STT → Translation → TTS
│   │   │   └── UtteranceQueue.ts
│   │   ├── stt/
│   │   │   └── WhisperService.ts
│   │   ├── translation/
│   │   │   ├── TranslationService.ts (interface)
│   │   │   ├── TranslationService.ios.ts (Translation framework)
│   │   │   └── TranslationService.android.ts (ML Kit)
│   │   ├── tts/
│   │   │   ├── ZipVoiceService.ts (primary, voice cloning)
│   │   │   ├── NativeTTSService.ts (fallback)
│   │   │   └── AudioPlayerService.ts
│   │   ├── audio/
│   │   │   ├── AudioCaptureService.ts
│   │   │   └── VADService.ts
│   │   ├── models/
│   │   │   └── ModelManager.ts
│   │   ├── auth/
│   │   │   └── validateApiKey.ts
│   │   └── memory/
│   │       └── MemoryMonitor.ts
│   ├── ui/
│   │   ├── primitives/
│   │   │   ├── PTTButton.tsx    # Main interaction object
│   │   │   ├── Text.tsx
│   │   │   ├── Button.tsx
│   │   │   └── Surface.tsx
│   │   ├── animations/
│   │   │   ├── Waveform.tsx
│   │   │   └── StateMorph.tsx
│   │   ├── sheets/
│   │   │   └── LanguagePickerSheet.tsx
│   │   ├── theme.ts            # Design tokens (colors, typography, spacing, motion)
│   │   └── haptics.ts
│   ├── screens/
│   │   ├── ConversationScreen.tsx    # Main bidirectional surface
│   │   ├── LanguagePairScreen.tsx    # First-run language setup
│   │   ├── SettingsScreen.tsx        # API key + history
│   │   └── ModelDownloadScreen.tsx   # Model loader
│   └── navigation/
│       └── types.ts
├── ios/ / android/ — native modules
└── App.tsx
```

---

## Key Design Decisions

1. **Voice cloning zero-shot:** No setup. Each PTT utterance becomes the voice reference for the next synthesis. First utterance per speaker uses OS TTS (no reference yet).

2. **Half-duplex:** One speaker at a time. Avoids feedback and simplifies the pipeline.

3. **Vertical PTT axis:** PTT at each phone edge (not center bar). Partner's thumb lands at top edge; user's at bottom. More natural for a table-flat phone.

4. **No divider line:** Silence between the source lines IS the visual divider. Honors the 180° split naturally.

5. **Object metaphor with halos:** Depth on true black via translucent layering, never drop shadows. Halos always-on at idle so the disc feels like a physical object resting in the screen.

6. **OS-native translation:** Zero extra memory footprint vs. bringing NLLB (~300MB).

7. **All on-device:** Zero cloud calls. Conversations never leave the phone.

---

## Roadmap

- **Phase 0** — Spike (Voxtral eval → ZipVoice chosen) ✅
- **Phase 1** — Shell + PTT + STT ✅
- **Phase 2** — Translation (iOS/Android) ✅
- **Phase 3** — TTS (ZipVoice + fallback) ✅
- **Phase 4** — VAD + Polish ✅
- **Phase 5** — UI Redesign (vertical PTT, halos, editorial theme) ✅ (commit a43525e)
- **Phase 6** — Final polish: haptic choreography across the turn lifecycle, tap-to-replay on translated text, status microcopy beside StateMorph, settling reveal with translateY, first-run hint, mom-tier guided onboarding for the API key (3-step plain-Spanish flow with Linking to Mistral console) ✅ (commit a34e6e7)

---

## Troubleshooting

**Build fails on Pod install (iOS):**
```bash
cd ios
rm -rf Pods Podfile.lock
pod install
cd ..
```

**Metro bundler issues:**
```bash
npm start -- --reset-cache
```

**Whisper/ZipVoice models not downloading:**
- Check device has >1GB free storage
- Verify network connectivity
- Logs available in Settings → Diagnóstico

---

## References

- **React Native Docs:** https://reactnative.dev
- **Whisper.rn:** https://github.com/recognito-ai/whisper-rn
- **Sherpa ONNX (ZipVoice):** https://github.com/k2-fsa/sherpa-onnx
- **Reanimated:** https://docs.swmansion.com/react-native-reanimated/
