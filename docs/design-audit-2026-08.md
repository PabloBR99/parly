# Parly Design Audit — August 2026

> **Implementation status (2026-08-05): all findings addressed.** C1–C6,
> H1–H14, and P1–P12 are implemented on this branch; the suite is 120 tests
> across 10 suites, all green, including the previously-unrunnable App suite.
> Three deliberate deviations from the fixes as written below:
> (1) **C1/C3** — notices carry a `NoticeKey` through the store and each half
> renders it in its reader's language via `src/i18n/strings.ts` (32
> languages), rather than storing English strings from a `humanize()` map;
> (2) **H1** — translation deltas stream to `translatedText` but the stage
> stays `translating` until the first sentence starts TTS ("speaking" before
> audio would be dishonest in the other direction; the spinner complaint is
> resolved by the streamed text itself);
> (3) **H14** — only a *definitively invalid* key disables the discs; a
> merely-unverified key stays usable while background validation races, so an
> offline launch with a good stored key doesn't lock the table. H7's
> interrupt landed on the translated text (listener side) only — the
> speaker's disc stays a pure PTT control.

Scope: full-repo review of pipeline correctness, perceived latency, the two-reader
table context, failure states, onboarding, and UI polish. Method: every file in
`src/` read in full, user flows traced end to end, README/PLAN cross-checked
against the implementation, test suite executed (98 tests pass; the App-level
suite fails to run — see P10).

Severity: **Critical** = breaks the product promise at the table. **High** =
noticeably degrades a real conversation or recovery. **Polish** = quality,
consistency, drift.

---

## Critical

### C1. Turn errors render only on the *listener's* half, in technical English — the speaker gets nothing

- **Where:** `src/screens/conversation/SpeakerHalf.tsx:210-214`, wiring in
  `src/screens/ConversationScreen.tsx:202-203`, error strings from
  `src/services/pipeline/ConversationOrchestrator.ts:290,315,913-916` and
  `src/services/translation/MistralTranslator.ts:301-309`.
- **What's wrong:** The error pane is driven by `incomingTurn?.stage === 'error'`,
  and `incomingTurn` for each half is *the other person's last turn*. When
  person B's speech fails, the error appears on person A's half. On B's own half,
  `activeTurn` is nulled by `failTurn` → the morph and microcopy silently vanish.
  The message itself is raw plumbing: `Voxtral handshake failed: WebSocket closed
  before session.created (code=1006 …)`, `HTTP 429: Rate limit exceeded.`
- **Why it hurts at the table:** The two people at the table *do not share a
  language* — that's the premise. The one person who can act (the speaker, who
  should press again) sees their status glyph disappear with no explanation; the
  error goes to the person who can't read it and can't relay it. A confused turn
  is the exact failure the README says the architecture exists to prevent.
- **Fix:** (1) Show the error on the **speaker's** half (or both), keyed off the
  speaker's own last turn. (2) Map every service error to one of ~5 plain
  sentences before it reaches the store:

  ```ts
  // errors.ts
  export function humanize(msg: string): string {
    if (/handshake|WebSocket|Network error|request failed/i.test(msg))
      return 'Connection dropped. Press and hold to try again.';
    if (/401|Authentication/i.test(msg)) return 'The key stopped working. Check Settings.';
    if (/429|Rate limit/i.test(msg))     return 'Too many requests — wait a moment.';
    if (/cancelled/i.test(msg))          return '';           // not an error to show
    return 'Something went wrong. Press and hold to try again.';
  }
  ```

  Store only the humanized string in `turn.errorMessage`; keep the raw string in
  the log buffer.

### C2. Audio-capture stop/start interleave kills the next turn's mic — silently

- **Where:** `src/services/audio/AudioCaptureService.ts:105-112` (`stopStreaming`
  removes `this.dataSubscription` **after** `await AudioRecord.stop()`), trigger
  path `src/services/pipeline/ConversationOrchestrator.ts:922` (`failTurn` calls
  `void stopStreaming()` fire-and-forget) and `:263` (`beginTurn` →
  `startStreaming`).
- **What's wrong:** `stopStreaming` clears the `streaming`/`recording` flags
  synchronously, then awaits the native stop, then removes
  `this.dataSubscription`. If the user presses PTT again during that await (a
  turn just errored — exactly when they *will* press again), `startStreaming`
  passes its guards, registers a **new** `data` listener into
  `this.dataSubscription`, and starts recording. The old `stopStreaming`
  continuation then resumes and removes… the new turn's listener. The new turn
  records audio that goes nowhere: no partials, empty final, turn "completes"
  with nothing.
- **Why it hurts at the table:** The recovery press after an error is the moment
  trust is rebuilt or lost. This race turns it into a second, *more* confusing
  failure — the disc animates, the user speaks, nothing appears, no error.
- **Fix:** Detach the listener before the await, using a local capture:

  ```ts
  async stopStreaming(): Promise<void> {
    if (!this.streaming) return;
    this.streaming = false;
    this.recording = false;
    const sub = this.dataSubscription;   // capture + null BEFORE any await
    this.dataSubscription = null;
    await AudioRecord.stop();
    sub?.remove();                       // removes THIS call's listener, never a newer one
  }
  ```

  Nulling the field before the await gives a concurrent `startStreaming` a clean
  slot; removing the *captured* `sub` after the stop preserves trailing-chunk
  delivery on the legitimate release path (which matters for H4). None of the 98
  tests cover this interleave (the mocks resolve `stopStreaming` immediately).

### C3. Conversation chrome is one-sided and English-only

- **Where:** `src/screens/ConversationScreen.tsx:228` (NetworkPill only on the
  partner's edge), `:251-261` (settings link only on the user's edge),
  `src/screens/conversation/helpers.ts:13-22` (`listening/thinking/speaking/error`),
  welcome copy `SpeakerHalf.tsx:184-208`, banner `ConversationScreen.tsx:287-296`.
- **What's wrong:** Two distinct problems. (1) The network pill exists only on
  the top (partner's) edge — the device owner reads connection state upside down
  at arm's length, or not at all. The audit criterion the product sets for itself
  is that anything readable from only one side is a bug. (2) Every piece of
  chrome — microcopy, welcome headline, error strings, a11y labels — is
  hard-coded English. The README describes a Spanish product ("en línea",
  "ESCUCHANDO", plain-Spanish onboarding); the code shipped English. Worse than
  the drift: this is a *translator*. The partner holding the top half may read
  Japanese and nothing else, and their status line says "thinking".
- **Why it hurts at the table:** Half the audience can't read the machine's
  state. The product's own premise (two people, no shared language) is violated
  by its own chrome.
- **Fix:** (1) Render the pill on **both** edge rows (it's 6 px + a word; the
  cost is nil), or move it onto the seam next to `SeamControl` where it's
  equidistant and neutral. (2) Localize `stageMicrocopy` per half, keyed by that
  half's `speakerLanguage` — a 32-language dictionary of four words each is a
  ~130-line table, and it makes each half legible to its reader:

  ```ts
  stageMicrocopy(stage, speakerLang)  // 'escuchando' on the es half, '聞いています' on the ja half
  ```

### C4. Nothing except the API key survives an app restart

- **Where:** `src/store/settingsStore.ts` (no persistence middleware),
  `src/App.tsx:36-45` (hydrates only the API key), `:63` (`initialRouteName`
  driven by the never-persisted `languagePairConfigured`).
- **What's wrong:** Language pair, `languagePairConfigured`, and the translation
  model live in a plain Zustand store. Every cold start lands on
  LanguagePairScreen with two empty cards, even for a user who has had a hundred
  conversations.
- **Why it hurts at the table:** The target user is non-technical. The app
  re-interrogating them about languages on every open reads as "the app forgot
  me / I broke it". It also delays the time-to-first-turn — the metric this
  product lives on — by a full setup screen.
- **Fix:** `zustand/middleware` `persist` over `personA.language`,
  `personB.language`, `translationModel`, `languagePairConfigured` with an
  AsyncStorage (or MMKV) adapter. ~15 lines. Keep the key in the keychain as
  today.

### C5. "change key" destroys the working key on a single tap

- **Where:** `src/screens/SettingsScreen.tsx:199-212` — `setApiKey('')` — which
  the App-level subscription (`App.tsx:38-44`) immediately propagates to
  `Keychain.resetGenericPassword`.
- **What's wrong:** One tap on a quiet text link erases the stored credential
  irreversibly. Mistral's console never re-shows an existing key, so the user
  cannot recover by "finding it again" — they must create a brand-new key,
  re-running the entire onboarding they struggled through once.
- **Why it hurts at the table:** This is the single most destructive action in
  the app, executed with less friction than changing a language.
- **Fix:** Don't clear on tap. Flip into an "enter a new key" edit state that
  keeps the old key until a *new* one validates:

  ```ts
  const [editingKey, setEditingKey] = useState(false);
  // "change key" → setEditingKey(true); show input + Verify; only on
  // validation 'ok' → setApiKey(newKey). Cancel → nothing lost.
  ```

### C6. Mid-stream network failure makes the translator replay the entire request — sentences get spoken twice

- **Where:** `src/services/translation/MistralTranslator.ts:138-206`
  (`defaultFetcher.postStream`).
- **What's wrong:** The whole fetch-streaming path — including the
  `reader.read()` loop — sits in one `try`. A network error *mid-stream* (the
  exact "WebSocket/connection dies mid-turn" case) is caught and falls through
  to the XHR fallback, which re-POSTs the full request from byte zero. Sentences
  already emitted through `onChunk → flushSentences → onSentence` have already
  been queued into TTS; the XHR replay emits them all again. `fullText`
  concatenates both attempts, so `onDone` writes duplicated text into the turn.
  The stale `sseBuffer` from the dead stream additionally corrupts the first
  event of the retry.
- **Why it hurts at the table:** After a network blip the phone speaks the
  translation twice (or one and a half times) and the on-screen text duplicates
  itself. To two strangers mid-negotiation this reads as the app malfunctioning
  at the worst possible moment.
- **Fix:** The fallback is only safe before any bytes arrived. Track it:

  ```ts
  let receivedAny = false;
  const guardedOnChunk: ChunkSink = (c) => { receivedAny = true; onChunk(c); };
  try { /* fetch path using guardedOnChunk */ }
  catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    if (receivedAny) throw e;      // mid-stream death is a real error — surface it
  }
  // ...XHR fallback only for the zero-byte case
  ```

---

## High

### H1. Translation text is withheld until a sentence boundary; the gap shows a spinner

- **Where:** `src/services/translation/MistralTranslator.ts:259-277` (sink emits
  only via `flushSentences`), `ConversationOrchestrator.ts:875-889` (store is
  updated only `onSentence`), `src/ui/animations/StateMorph.tsx:43-44` (the
  `translating` stage is a rotating ring — a spinner).
- **What's wrong:** Between transcript-final and the first completed sentence
  (min 15 chars + boundary), the listener sees a spinner while translated tokens
  are already arriving over SSE and being thrown on the floor for display
  purposes. Sentence chunking is the right unit for **TTS**; it is the wrong
  unit for **text**. The brief's own standard: any spinner that could be
  progressive text is a flag — this is the flagship instance.
- **Why it hurts:** The first visible token is the moment the listener knows the
  machine understood. Today that moment is delayed by the full length of the
  first sentence — often 1–3 s of model time — while a ring rotates.
- **Fix:** Add an `onDelta(fullSoFar: string)` callback next to `onSentence`;
  call it on every SSE delta; in the orchestrator, write it to
  `turn.translatedText` (throttle to one store write per ~80 ms if needed) and
  move the stage to `speaking` on first token. Keep `onSentence` exclusively for
  the TTS queue. The reveal animation is already keyed on a boolean
  (`hasIncomingText`), so streamed text won't retrigger it — the UI is already
  built for this.

### H2. A quick press-and-release silently discards the user's speech

- **Where:** `ConversationOrchestrator.ts:281-287` (handshake-abort path ends
  the turn as `done` with empty text), `VoxtralRealtimeClient.ts:330-337`
  (`end()` during `connecting` rejects and throws the queued audio away).
- **What's wrong:** If PTT is released before the WebSocket handshake resolves
  (cold start, weak network — up to several seconds), the turn is cancelled and
  the audio queued in `preSessionChunkQueue` is discarded. Short utterances —
  "sí", "ok", "gracias", the most common turns in a live conversation — are the
  ones most likely to fit entirely inside the handshake window.
- **Why it hurts:** The user spoke, the disc animated, and nothing happened. No
  error, no text, no sound. Worse: the turn ends `done`, so `useTerminalHaptic`
  fires the *success* haptic — the phone physically confirms a turn that never
  happened. Dead air is the product's stated worst enemy.
- **Fix:** On release-during-connecting, don't abort — set a `flushOnReady`
  flag. When `session.created` arrives, drain the queue, send
  `input_audio.flush`/`end`, and let the turn complete normally. The queueing
  half of this design already exists; only the release path throws it away.

### H3. An empty transcript ends the turn with zero feedback

- **Where:** `ConversationOrchestrator.ts:851-856`.
- **What's wrong:** Voxtral returning empty/whitespace (too quiet, mic muffled,
  permission half-granted) ends the turn as `done` with empty strings. Nothing
  renders anywhere — and the `done` transition fires the success haptic
  (`useTerminalHaptic`), actively signalling the opposite of what happened.
- **Why it hurts:** "Did it hear me?" is the question the UI must never leave
  open. This path leaves it open every time.
- **Fix:** Route it through the (fixed, C1) speaker-side notice with copy like
  *"I didn't catch that — hold the button and speak close to the phone."* — a
  distinct, quieter treatment than an error.

### H4. Capture stops at the instant of release — final syllables get clipped; the comment claims a hangover exists

- **Where:** `ConversationOrchestrator.ts:297-317` (`endTurn` stops streaming
  immediately), comment at `:140-141` ("same as PTT hangover" — there is no PTT
  hangover anywhere in the code).
- **What's wrong:** People release PTT on the last syllable, not after it. With
  zero grace period, the tail of the utterance (often the word that matters) is
  cut, and `react-native-audio-record`'s in-flight final buffer may be dropped
  because the listener is removed as part of the same stop.
- **Fix:** ~250 ms grace before `stopStreaming()` in `endTurn` (state already
  moved to `transcribing`, so the UI is honest during it):

  ```ts
  this.state = 'transcribing';
  store.updateTurn(id, { stage: 'transcribing' });
  await new Promise(r => setTimeout(r, 250));   // capture the released syllable
  await this.deps.audioCapture.stopStreaming();
  ```

### H5. Mic permission is requested once at launch and the answer is ignored

- **Where:** `src/App.tsx:32` (`void audioCaptureService.requestPermission()`),
  `ConversationOrchestrator.beginTurn` (never checks; the `AudioCapture`
  interface's `requestPermission` has no other caller).
- **What's wrong:** Permission is primed at app start with no context (bad
  practice — the user has no idea why), and if denied, every subsequent turn
  proceeds into `AudioRecord.start()` recording silence → H3's silent-empty
  path, forever, with no recovery copy and no link to system settings.
- **Fix:** Request lazily on first PTT press; on denial, show a speaker-side
  notice: *"Parly needs the microphone. Enable it in your phone's settings."*
  with `Linking.openSettings()`. Check `PermissionsAndroid.check` in
  `beginTurn` before starting capture.

### H6. Missing TTS voice fails silently — wrong-language voice or nothing, and the UI never says so

- **Where:** `src/services/tts/NativeTTSService.ts:77-97` (`applyLanguage` falls
  through all catches, leaving the *previous* voice active), `:189-191`
  (`tts-error` resolves the chunk promise as success).
- **What's wrong:** If the device has no voice for the target language, chunks
  are spoken with whatever voice was last set (Spanish text read with English
  phonemes — worse than silence) or dropped, and `speakChunk` resolves either
  way. The README's troubleshooting section claims "the translation still
  appears even when TTS can't speak it" — true, but the app never tells the user
  *why* there's no audio, and the actual behavior is often garbled audio, not
  absence.
- **Fix:** `applyLanguage` should return whether a voice was found; surface a
  one-time per-language notice on the listener's half — *"No voice installed for
  Español — showing text only"* — with the Android install-voices deep link.
  Have `speakChunk` report `tts-error` distinctly (resolve with a status, not
  void) so the orchestrator can mark the turn "spoken: no".

### H7. There is no way to interrupt a turn

- **Where:** `ConversationOrchestrator.ts:320` (`cancelTurn` exists, fully
  implemented); zero call sites in any screen.
- **What's wrong:** Once a turn is translating/speaking, both discs are locked
  and nothing on screen can stop it. A mistranscription of a 30-second ramble
  will be translated and spoken in full while both parties wait.
- **Why it hurts:** Half-duplex discipline is right; a half-duplex lock with no
  abort is an elevator with no door-open button.
- **Fix:** Tap the big translated text (or the speaker's own disc) during
  `speaking` → `cancelTurn()`. The orchestrator already does everything needed —
  this is a one-line affordance plus copy.

### H8. The hands-free "couldn't route your speech" flash is dead code — discards are invisible

- **Where:** `src/screens/conversation/SpeakerHalf.tsx:103-112` —
  `unroutedFade` is written by the effect and **never read by any animated
  style**. Store plumbing (`hfUnroutedSpeaker`) drives a value that affects
  nothing on screen.
- **What's wrong:** When an HF utterance's detected language isn't in the pair,
  the orchestrator discards it and sets the flash flag — and the flash doesn't
  render. The speech vanishes with zero feedback.
- **Fix:** Bind it (e.g. wrap the bloom layer):

  ```tsx
  const bloomFade = useAnimatedStyle(() => ({ opacity: unroutedFade.value }));
  // <Animated.View style={[styles.bloomLayer, bloomFade]}><Bloom …/></Animated.View>
  ```

  Better: pair it with a one-word microcopy blink ("¿otra vez?" / localized) —
  a dimming bloom alone is too subtle for the event it reports.

### H9. Hands-free keeps streaming the phone's own TTS into Voxtral

- **Where:** `ConversationOrchestrator.ts:364-367` (dual-path capture always
  feeds Voxtral), `dispatchHfTurn` gates only the VAD (`:669`), never the
  Voxtral feed; `VoxtralRealtimeClient` keeps accumulating deltas between
  flushes.
- **What's wrong:** During TTS playback the mic keeps sending audio to the
  Voxtral session. VAD is off, so no speech_end fires, but the *accumulator*
  keeps growing with the transcript of the phone's own speaker output. The next
  `flushUtterance` returns the user's next utterance **prefixed with the echo of
  the last translation**, which the router will happily detect as the other
  language — a feedback-loop ingredient. Today this is mitigated only by
  `VOICE_COMMUNICATION`'s AEC, which is wildly device-dependent.
- **Fix:** Stop feeding Voxtral while `hf-speaking`/`hf-cooldown` (drop chunks
  in the capture callback), and clear the client's accumulator when re-arming
  VAD after cooldown (a `resetUtterance()` on the client, or flush-and-discard).

### H10. The "transcribing" glyph still says "listening" after the mic is closed

- **Where:** `src/ui/animations/StateMorph.tsx:41-42` (`transcribing` renders
  the same `Waveform` as `recording`); the file's own header (`:6`) documents a
  "traveling tick" that was never built.
- **What's wrong:** After PTT release the mic is off, but the glyph — the one
  element the README says makes the system legible without reading — continues
  to show capture bars. Users keep talking into a dead mic.
- **Fix:** Give `transcribing` a distinct treatment (the documented tick, or
  freeze the bars and fade them). The microcopy already switches to "thinking";
  the glyph must agree with it.

### H11. Waveform animates `height` — layout work on every frame, during audio capture

- **Where:** `src/ui/animations/Waveform.tsx:77-80`. Contrast with
  `src/ui/primitives/SeamControl.tsx:18-20`, whose comment states the fix
  verbatim: scaleY is "rock-solid on Android — far smoother than animating
  height".
- **What's wrong:** Five bars re-layout every frame of a 520–700 ms loop exactly
  while the JS thread is busiest (audio chunks, base64 decode, store writes per
  partial). The codebase already knows better — one component learned the
  lesson, the other didn't.
- **Fix:** Fixed `height: maxHeight`, animate `transform: [{ scaleY }]` — the
  same shape SeamControl uses. Five-minute change.

### H12. Offline press = 8 seconds of fake "listening"; the pill lags up to a minute; the hook to fix it exists and is never called

- **Where:** `VoxtralRealtimeClient.ts:42` (`HANDSHAKE_TIMEOUT_MS = 8_000`),
  `ConversationScreen.handleMicPressIn` (no network gate),
  `src/services/network/monitor.ts:39-46` — `probeNetworkNow()` whose doc
  comment says "the orchestrator calls this after an online failure"; nothing
  calls it.
- **What's wrong:** Pressing PTT while offline shows `recording` + "listening"
  for up to 8 s before failing (airplane mode fast-fails via `onerror`;
  degraded/black-hole networks ride the full `HANDSHAKE_TIMEOUT_MS`) — into
  C1's wrong-side error. Meanwhile the pill can honestly claim "online" for up
  to ~66 s after a drop (30 s cadence × 2-failure threshold + 3 s timeouts).
- **Fix:** (1) In `failTurn`, call `probeNetworkNow()` — one line, closes the
  loop the comment promises. (2) If `networkStore.state === 'offline'` at press
  time, short-circuit with the offline notice instead of opening a doomed
  socket. (3) Drop the handshake timeout to ~4 s; at 8 s nobody is still
  waiting.

### H13. Status and error type is illegible at table distance

- **Where:** `theme.ts:33-34` (`fgFaint` = 36 % white ≈ **3.3:1** contrast
  across the dusk backdrop's stops; `fgGhost` = 16 % ≈ **1.5:1**), used for:
  stage microcopy at 10 pt italic (`SpeakerHalf.tsx:250-253`), source lines, the
  welcome-flow language arrow, the network pill label. The error pane is
  `bodySmall` (13 pt).
- **What's wrong:** The product spec is glanceable at ~50 cm in a bright café.
  3.3:1 sits below the 4.5:1 WCAG AA minimum that applies to 10–13 pt text (the
  3:1 concession exists only for ≥18 pt), and these are the strings that report
  machine state and errors — the highest-stakes text on screen. `fgGhost` at
  1.5:1 fails every threshold yet carries the instructional welcome-flow arrow.
  The 34 pt translation text is fine (fg ≈ 18:1); everything *about* the
  pipeline is whispered.
- **Fix:** State/error strings move up to ≥13 pt and ≥`fgMuted` (62 % ≈ 7:1);
  error copy gets `body` size (15 pt) plus the error tint. Keep `fgFaint` for
  genuinely decorative chrome (the version tag), not for anything a user must
  read to operate the app.

### H14. A pasted-but-never-validated key sails straight into a failing conversation, under a green "Connected" badge

- **Where:** `SettingsScreen.tsx:167-179` ("Connected to Mistral" + green dot
  rendered for **any non-empty string**), back-navigation is never gated,
  `ConversationScreen.tsx:122` (`noKey` checks emptiness only).
- **What's wrong:** Paste garbage → tap the OS back button → the banner clears,
  the discs enable, the settings card says "Connected to Mistral" with a green
  dot — all before any request has succeeded. First turn fails with C1's raw
  handshake error.
- **Fix:** Track a `keyValidatedAt`/`keyStatus` in settings; the green card and
  the conversation gating key off *validated*, not *non-empty*. If the user
  backs out with an unvalidated key, validate silently in the background and
  keep the onboarding banner until it passes.

---

## Polish

### P1. README is fiction in seven places

`README.md` vs code: tap-to-replay "shipped in v6" — **no replay code exists
anywhere** (`grep -ri replay src/` is empty); Spanish chrome (`en línea`,
`ESCUCHANDO`, `mantén pulsado para hablar`, Spanish onboarding) — all English in
code; "63 passing tests" — 98 pass and the App suite can't run; "no language
code text inside the disc" — `PTTButton.tsx:300` renders it; "96 pt disc" —
`SIZE = 108`; `MistralTranslator.ts:21` says "~30 chars" — `MIN_CHUNK_LEN = 15`;
`monitor.ts:41` says the orchestrator calls `probeNetworkNow` — nothing does.
Docs that overpromise are worse than no docs: they cost the next contributor a
verification pass on every claim. Fix the README or ship the features it
describes — replay in particular is a good feature that already has store
support (`findLastTurn`) and a one-call implementation
(`tts.speakChunk(lastTurn.translatedText, lastTurn.targetLang)` gated on idle).

### P2. Every keystroke of the API key fires a real chat-completion request and a keychain write

`ConversationScreen.tsx:53-58` re-runs `configure()` + `prewarm()` on every
`apiKey` change (the screen stays mounted beneath Settings), and
`MistralTranslator.prewarm` sends an actual `max_tokens: 1` completion. Typing a
64-char key = dozens of 401s against Mistral plus dozens of serialized keychain
writes (`App.tsx:38-44`). Debounce the subscription (~500 ms) and only prewarm
keys that have validated.

### P3. `turns` grows without bound and every STT partial maps the whole array

`conversationStore.ts:63-69`. A long session accumulates hundreds of turns;
`updateTurn` clones the array on every partial delta (several per second during
recording — the frame-budget-critical window). Cap the array (keep last ~50) and
consider holding the active turn in a separate field so partial updates touch
one object.

### P4. Hard-coded colors and duplicated type outside the theme

`SpeakerHalf.tsx:339-345` re-declares `font.displayHero` by hand (34/42/300/-0.6)
instead of referencing it; `ConversationScreen.tsx:335` banner `#0E0E0E` and
`LanguagePickerSheet.tsx:284` `#0B0B0B` are near-miss variants of `color.bg`
(`#0B0B11`); `Button.tsx:103` danger border, `OnboardingSteps.tsx:292-293`
success tints, and PTTButton's disc border/tick whites (`PTTButton.tsx:181,353`)
are all inline. Each is small; together they guarantee the next palette pass
misses surfaces. Promote them to tokens (`color.successSoft`,
`color.dangerBorder`, etc.) or reference existing ones.

### P5. Debug scaffolding shipped in LanguagePairScreen

`LanguagePairScreen.tsx:63-88` — `onPick` logs "step 1", "step 1 done",
"step 2: haptics.tick", "step 3 done — onPick complete" around three trivial
calls, wrapped in a try/rethrow that adds nothing. Delete; it's noise in the
exact log buffer a user would export when something real breaks.

### P6. The key input masks what the user pastes

`OnboardingSteps.tsx:120` — `secureTextEntry` on the paste target. The mom-test
user pastes a long opaque string and sees dots; they cannot confirm the paste
took the whole key (partial clipboard grabs are the #1 failure of this flow).
An API key on a personal device gains ~nothing from masking during entry. Show
it (or first/last 4 with a reveal toggle).

### P7. Pressing a disc that will be ignored still fires haptics and press animation

`PTTButton.tsx:135-140` fires `haptics.tap()` + spring before
`ConversationScreen.handleMicPressIn`'s guard (`:152`) silently drops the press
(own turn still translating/speaking). The user feels an acknowledgment the
machine didn't give. Pass the guard down as `disabled` (the speaker's own disc
should be disabled during `translating`/`speaking` too) so the physical and
logical affordances agree.

### P8. The partner's picker has a search field the partner can't use

`LanguagePickerSheet.tsx:206-219` in the `side="top"` (180°-rotated) sheet: the
system keyboard opens unrotated at the *bottom* of the phone — the user's side —
while the partner is reading upside-down at the top. Typing is physically
impossible from their seat. Drop the search field from the top-side sheet (32
languages group-scrolls fine) or accept that language changes are owner-mediated
and say so.

### P9. Accessibility labels leak internals

`PTTButton.tsx:194` — "Microphone es" (code, not name; use
`getLanguage(label).name`). `SeamControl.tsx:253` bakes state into the label
string ("Hands-free, paused, offline") instead of using `accessibilityState` /
`accessibilityValue`.

### P10. The App-level test suite cannot run, and Jest leaks a worker

`__tests__/App.test.tsx` dies on `SyntaxError: Unexpected token 'export'` from
`@react-navigation` — `jest.config.js` has no `transformIgnorePatterns`
whitelist for it. So the only test that mounts the real component tree has never
run in CI. Jest also warns of a force-exited worker (likely the NetworkMonitor
timer or logStore flush timer — neither test tears them down). Add:

```js
transformIgnorePatterns: [
  'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-.*|@dr\\.pogodin)/)',
],
```

### P11. Test-coverage gaps against the race conditions that matter

The 98 tests are good on happy paths and HF reconnects, but none cover: the C2
capture interleave; release-during-handshake (H2); WS death during
`translating`/`speaking` (only mid-`recording` is tested); TTS queue state after
`failTurn` mid-speak (that `tts.stop()` actually unblocks the pending
`Promise.all`); the C6 fetch→XHR duplication; `endTurn` double-invocation; and
`NativeTTSService`/`AudioCaptureService` have no test files at all — the two
collaborators that talk to real native modules and event emitters (where the
listener-leak and utterance-matching logic lives) are the two with zero
coverage.

### P12. Minor pipeline nits

`VoxtralRealtimeClient.end()` polls with `setTimeout(tick, 50)` instead of
resolving from the `transcription.done` handler; `speakChunk` resolves `void` on
`tts-error` (fold into H6); PTT turns aren't torn down on app-background (HF is
— `ConversationScreen.tsx:62-75`; a backgrounded mid-turn PTT keeps the WS and
mic alive until the turn ends); the error-stage StateMorph is a 6 px static dot
(invisible at distance; fold into H13); `TRANSLATION_MODELS` /
`setTranslationModel` (`settingsStore.ts:10-16,54`) have zero UI call sites — a
three-model picker the store and README advertise that no screen renders (dead
settings surface: `ministral-3b` / `mistral-large` are unreachable).

---

## Top 5 changes by impact-to-effort

1. **Speaker-side, plain-language error + empty-transcript notices (C1 + H3 + the
   `humanize` map).** A day of work; converts every failure mode from "confusing
   turn" to "obvious next step", which is the product's own definition of the
   worst failure. Nothing else on this list matters if the user can't tell what
   went wrong.
2. **Persist settings (C4).** ~15 lines of `zustand/persist`. Removes an entire
   unnecessary screen from every single app open for every returning user.
3. **Stream translation deltas to the screen (H1).** One callback in the
   translator, one throttled store write. Cuts perceived latency by the length
   of the first sentence on every turn — the single biggest "feels instant" win
   available.
4. **Fix the capture stop/start race + add the release hangover (C2 + H4).**
   Ten lines total in `AudioCaptureService`/`endTurn`. Eliminates the
   dead-mic-after-error trap and stops clipping final syllables — both are
   trust-destroying and both are trivially mechanical fixes.
5. **Guard "change key" behind a validate-then-replace flow (C5).** An afternoon.
   Removes the one tap in the app that can strand a non-technical user with no
   recovery path.

*(Honorable mention: the C6 one-flag fix — `receivedAny` — is five lines and
removes the only bug that makes the app actively speak wrong output.)*
