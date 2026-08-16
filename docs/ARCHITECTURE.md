# Architecture

Deep dive into how Parly works. For the short version, read the [README](../README.md) first.

## Pipeline

Every turn runs the same streaming pipeline; no stage waits for the previous one to fully finish:

```
PTT held ──► AudioCaptureService (PCM 16kHz mono, base64 frames)
                    │
                    ▼
              SpeechAgc (slow level normalisation, speech-gated)
                    │        └─ the VAD and the meter branch off ABOVE this,
                    │           on the raw samples
                    ▼
              VoxtralRealtimeClient (WebSocket, 480 ms right context)
                    │  transcription.text.delta  → live partial
                    │  transcription.done        → final
                    ▼
              nameRepair (phonetic glossary — Sisi → Cycy)
                    │
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
- **Routing:** the turn's direction is decided from the *transcript text* (script/stopword classification), not just Voxtral's audio language tag — this is what prevents same-language echo loops when the tag misfires. When the text decides nothing the turn falls back to blind alternation, so a gap in a language profile does not read as "unsure", it reads as "wrong direction": *"I'm from Madrid"* scored zero for English (the tokenizer keeps the apostrophe, so `i'm` matched neither `i` nor `am`, and `from` was missing outright), was routed as Spanish, and came back untranslated. Contractions now also match by their stem.
- **Echo gating:** while the phone speaks (and for a 250 ms cooldown after), mic audio is not fed to the transcriber and the VAD is disarmed, so the phone never transcribes its own voice. On re-arm, the transcriber's utterance buffer is reset to scrub anything that leaked in flight. This gate is the *only* defence, by design: hardware echo cancellation was always too device-dependent to rely on, and the capture path uses `VOICE_RECOGNITION` (Android audio source 6), which offers none — its noise suppressor was deleting quiet speech, and its gain control was clipping near speakers at full scale.
- **The wave is the meter:** the same 512-sample frames that drive turn detection also carry a loudness measurement (RMS → dBFS → envelope follower) that is published on `services/audio/audioLevelBus` and drawn as the seam control's wave. It travels the pub/sub bus rather than the store because 31 updates/s through Zustand would re-render the whole two-sided surface to move seven 2 px bars. The gate above applies to the meter too — audio the phone is hearing from its own speaker moves nothing, so the wave can never visualise the app's own voice.
- **The trade-off:** speech during playback is not captured (half-duplex by design). Tapping the streaming translation skips the readback and returns to listening in ~250 ms.
- **The model is not load-bearing.** Every frame carries an RMS energy reading alongside the model's probability, and either can call speech. That started as a fallback and became the primary path on at least one device, where Silero returns ≈0.002 for speech loud enough to clip. So the VAD runs without a session at all if it has to — which is what makes the guard below survivable rather than fatal.
- **The energy path uses two thresholds, not one.** Starting a turn costs more evidence than continuing one (0.05 RMS to enter, 40% of that to sustain). One threshold cannot do both jobs: speech is not a plateau, and a bar set high enough to ignore a room with a television in it sits *inside* the ten-to-twenty dB spread between the vowels and consonants of the sentence it is meant to be tracking. With a single bar the detector saw whole sentences as a few loud syllables adrift in silence and let the hangover expire in the middle of them — measured at 96 ms, 180 ms and 410 ms of "speech" for three utterances that were each a full sentence, two of which reached the transcriber as nothing at all. Splitting the bar separates the two failures: the entry bar fights false starts, the sustain bar fights chopped sentences, and moving one no longer drags the other. A sustain bar close to room noise can hold a turn open indefinitely, so a 15 s ceiling ends one that no frame ever will — reaching it is a bug report, not a feature.
- **Getting the model ready only gets one try.** Copying 2 MB out of the APK, renaming it into place and handing the path to a model loader is native work end to end, and any of it can end the process with nothing catchable and nothing logged: the app just closes, and since turning hands-free on is what triggers it, the next attempt does the same thing. The whole stretch is therefore claimed on disk before the first native call and released when the last one returns, failure included. A claim still standing at the next launch can only mean the work never returned, and that run skips the model and listens on energy alone — clearing the claim as it honours it, so one bad run is not a life sentence. **This guard was built chasing the wrong fault** (see the API key note below), which is the argument against making it sticky: the realistic failure here is now a false positive, and answering a false positive by disabling on-device speech detection permanently and silently is the worse way to be wrong. Skipping one launch breaks a loop and is cheap enough to be wrong about. Each step also runs under a 4 s deadline — chosen under Android's ~5 s input-dispatch ANR window — so a native call that merely stops answering costs the model rather than the turn, and `initialize()` never throws: the answer to "no model" is a VAD on energy, not a dead feature. The model file is copied via a scratch path and renamed rather than written in place, so a copy interrupted halfway can no longer leave a truncated model that every later launch accepts on sight.

### The wait between "…?" and the answer

Everything from the last syllable to the first spoken word is one serial chain, and each link was bought back with evidence rather than by shortening a timeout. Every number below is measured on a device, not budgeted:

```
       silence ─► endpoint ─► transcript ─► translation ─► first sentence ─► first audio
                  hangover    flush→final     request        boundary          engine
slow              ~620 ms      ~230 ms       ~440 ms        ~60 ms            ~85 ms   ≈ 1470 ms
fast              ~620 ms       skipped      ~195 ms        ~65 ms            ~80 ms   ≈  990 ms
```

The starting point was ~2560 ms. The fast path is what an ordinary sentence took: spoken long enough that partials arrived before it ended, so the final was skipped and most of the request had already flown. A short utterance could not take it — nothing had been transcribed when the silence ran out — and paid the slow path, which is backwards for a conversation made mostly of short turns. Asking for the transcript at the pause hint (below) is aimed exactly there; the numbers above predate it and will be replaced when the next device run lands, not before.

- **Endpointing is two-stage, and driven by evidence rather than by the clock.** Silence is weak evidence that a person finished talking — strong enough only after a long wait, which is why the hangover sits at the front of every reply. So the VAD also emits an early *pause hint* at 280 ms, and the orchestrator answers it with evidence the VAD doesn't have: whether the transcript just closed a sentence. Voxtral punctuates, and a full stop is the one signal that distinguishes finishing a thought from drawing breath. A hint over a transcript that stops mid-clause is ignored and the full hangover runs. This matters because the hangover is not padding: an utterance split in two loses its second half, which arrives while the mic is gated behind the readback of the first.

  The hint cannot be acted on the instant it fires. Voxtral buffers `target_streaming_delay_ms` of audio, so at 400 ms of silence the words just spoken are still in flight — the first device measurements showed every shortcut declining for exactly this reason, a timer asking its question before the answer existed. The hint therefore only *arms* a check; each delta re-arms it; it fires when the transcript stops growing, which is the earliest moment we know what was said. If speech returns first, the VAD says so (`onSpeechResume`) and everything the hint set in motion is undone.

- **The transcript is asked for, not waited for.** The first version of the hint could only read what Voxtral had volunteered — and for a short utterance Voxtral volunteers nothing: no delta is ever streamed, every word arrives in the final, and the final is only requested once the hangover concedes. So the words existed nowhere until ~850 ms after the speaker stopped, every shortcut declined as `no-transcript`, and the turns that paid the *worst* latency were the short ones a conversation is mostly made of. Long sentences took the fast path fine, which is exactly why three rounds of measuring on long sentences never saw it.

  The segment is now closed at the pause hint — **once the transcript has stopped growing** — so that round trip runs *during* the silence instead of after it. Both endings gain: an utterance whose answer closes a sentence ends on punctuated evidence without the hangover, and one that doesn't still finds its transcript already in hand when the hangover expires. The round trip is also the safety margin — the answer lands around 500 ms of observed silence, and a speaker who was only drawing breath has resumed by then, which cancels everything the hint armed. Closing early never costs the rest of the sentence either: words spoken after it stream into a fresh segment and are stitched back on. Closing while a close is outstanding joins it rather than opening a second, so the ending and the guess share one answer.

- **Closing a segment costs words, and for one release nobody had counted them.** The flush ends the segment, so everything after it is recognised with no memory of the sentence it continues — and Voxtral is an LLM-based recogniser, so the words already transcribed are precisely what it leans on when the audio is ambiguous. Which is what fast conversational speech *is*: reduced, coarticulated, consonants swallowed, thin acoustic evidence per word. And 280 ms of quiet is not necessarily a gap between words. Inside one — a stop closure, a hesitation — the cut lands mid-word, and neither half is a word any more, so both get written as something that is. A speaker who takes breaths mid-sentence was paying that twice a sentence.

  The close is therefore armed by the pause hint and *sent* by the same settle check that guards the fast path: no flush while deltas are still arriving. It costs nothing on the case the early close exists for (a short utterance streams no deltas at all, so the check fires immediately) and up to 140 ms on the case where cutting was a bad idea anyway. A speaker who resumes before it fires now costs no boundary at all, rather than one per breath.

  **A pause hint is not once per utterance.** A speaker who takes a breath mid-sentence pauses more than once, and each pause is a fresh chance to have the words in hand — the short tail after the breath is exactly the case with no streamed deltas at all. The close in flight is what suppresses a second one, and it stops being in flight the moment it answers; the resumed speaker's next pause opens its own. That distinction used to live in three unrelated fields cleared by hand in the resume handler, one of which was missed, so the hint fired once per utterance and never again — silently, since the fallback is just the slower path that always worked.

- **The final is usually a formality.** The close→final round trip asks the server for a transcript it has already streamed: Voxtral buffers `target_streaming_delay_ms` of audio, and the silence the endpointer just waited through is longer than that, so by the time a turn ends the deltas normally carry every word of it. So `closeSegment()` answers twice — `textSoFar` immediately, `final` after the round trip — and the turn takes whichever it needs. The guard on taking the fast one is that the transcript must have *stopped growing* (140 ms with no delta); anything still arriving is the tail of the sentence, and this drops it.

  Two methods once did this (`flushUtterance` waited, `commitUtterance` did not), which is one method too many: the caller had to choose before it knew which it needed, and the two disagreed about who owned the deltas arriving between the flush and its answer — a disagreement papered over by a ledger of outstanding commits in the client and a compensating wipe in the orchestrator. They belong to the segment being closed. The server closes it on receiving the flush, so anything still arriving is it catching up on audio it already had; the accumulator is emptied at close time and a late answer can no longer eat the next speaker's opening words.

- **The shortcuts refuse unless the turn's direction is settled.** Skipping the final also skips the audio language tag that comes with it, so a merely-leaning transcript would be acting on evidence the tag might have overruled. A fast turn delivered to the wrong reader is worse than a slow one. But that reasoning assumes the tag arrives: measured on device, Voxtral returns none at all (`routedLanguage: null`, every turn), so the gate was guarding a second opinion that never comes and declining every shortcut for nothing. The gate now counts consecutive untagged utterances, and after two it accepts a weak vote — which is exactly what routing falls back to anyway once the tag is absent. A tag arriving resets the count and strictness returns immediately; the shortcut path can still see one, since `transcription.language` arrives mid-stream.

- **Nothing is warmed in front of the sentence that matters.** Both voices of the pair are primed when hands-free starts, before anyone has spoken. The silent primer costs a real synth-and-play cycle in the native engine, so re-warming an already-hot voice queues *ahead* of the real sentence and adds the latency it was meant to remove — it is skipped unless the voice changed or went cold.

  Switching voices costs ~250 ms, measured as the entire difference between two otherwise identical turns. That is a per-alternation tax, and a conversation is nothing but alternation — so the switch happens in the cooldown after each readback, to the voice the *reply* will need rather than the one just used. It is a bet on the conversation alternating, and the losing side of the bet is a switch that would have been paid anyway.

  It *selects* the voice; it does not warm it. The first attempt called the full warmup, and the primer it queues is a real synth-and-play cycle: sitting in the native queue between turns, it went out ahead of the next reply and roughly tripled that reply's time to audio on device — 112 ms average before, 332 ms after. The comment on the warm TTL had predicted exactly this and it was done anyway. Warming belongs before a conversation starts, where nothing is behind it; between turns, only the selection is safe.

- **The translation is sent once, not twice.** React Native's `fetch` is the whatwg-fetch polyfill: it has no `ReadableStream`, `response.body` is undefined, and its promise does not resolve until the whole response has arrived. A "try fetch, fall back to XHR" fetcher therefore succeeds, gets a body it cannot stream, and re-POSTs from byte zero — every translation ran twice in series, one full request completed and discarded ahead of the real streaming one, on the user's own metered key. The transport is now decided from `Response.prototype` before any request is made. React Native only delivers XHR chunks incrementally when `onreadystatechange` or `onprogress` is set before `send()`, which is why the XHR path wires its handler first.

- **The translation is one object, sent as early as the evidence allows.** A speculative path and a normal path would be two of everything — two ways to stream, two ways to fail, and tests that only reach the easy one. There is instead a single `TranslationRun` per turn: the turn attaches to it and replays whatever already arrived, and a translation that was never sent early is simply a run whose buffer is empty when the turn attaches.

- **The translation is sent before the turn is certain.** Measured on a real device, the request to Mistral was ~60 % of the whole wait — larger than the endpoint, the transcript and the speech engine combined. So it is sent at the pause hint, on the transcript in hand, while the endpointer is still waiting out silence. Nothing reaches the screen or the speaker until a real turn *adopts* it, and a turn only adopts a stream whose source text and direction match what the utterance actually turned out to be — compared with punctuation, case and accents folded away, since tidying those is exactly what the server's final does and none of it changes the translation. A miss costs one request and falls back to the normal path; a hit costs nothing and started several hundred milliseconds early. Guesses are capped at two per utterance and never made on speaker alternation, which is not evidence about the utterance at all. On device the head start measures 130–300 ms, and what is left of the request after the turn ends drops to ~195 ms — a fifth of the wait, from three fifths.

- **A translation that comes back as its own input is not a translation.** Routing decides direction from the transcript, and when the transcript cannot decide there is a fallback to blind speaker alternation — which is a coin flip reported with the same confidence as evidence. Lose it and the app asks for a language to be translated into itself, the model returns the sentence unchanged, and the speaker hears their own words read back. Observed on device: *"Genial."* came back *"Genial."* — the word is in neither lexicon (it is English too), the audio tag was absent on every turn of that session, and the speaker had been talking alone, so alternating from the last turn pointed at the wrong half every time.

  No lexicon fixes that, because there is genuinely no evidence in a one-word homograph. The translation itself is the evidence, and it arrives before anyone has to hear it: a direction that was *guessed* — `fallback` alternated, or `matched` took the audio tag's word for it — is run and read before the turn starts. If it returned its own input, the other direction is tried and whichever produced a real translation is what the turn uses. If both come back unchanged the word genuinely survives translation (*Madrid*, *hotel*, *OK*) and the guess stands; two requests is the cap. A direction the transcript chose is never second-guessed, so this costs nothing on the path that already worked. `direction` in `[hf_turn]` reads `from-transcript`, `kept` or `flipped` — `kept` being the check running and finding nothing wrong, which must not look like the check never running.

  The cost is that a guessed turn does not stream to the screen while it is checked. That is affordable precisely because it is the ambiguous ones that get there: a transcript the lexicon cannot place is a handful of words, and its translation arrives whole.

- **The measurement starts where the person starts waiting.** The `[hf_turn]` log line breaks the whole chain into segments that add up, measured from the last speech frame (not from when the hangover conceded) to the `tts-start` event (not to when a chunk was queued). `speechEndToAudio` is the number; everything else in the line explains it. `requestToOpen` / `openToFirstToken` split the request's own cost into getting answered (connection, queue, prefill) and the model writing — two very different fixes, indistinguishable from one number. `fastPathBlock` says why a shortcut declined, because a shortcut that silently never fires looks exactly like one that does — and it is what showed that the first two rounds of work had never once executed. `earlyClose` / `earlyCloseMs` report the pause-hint round trip, which ran inside `endpointDelay` and so is reported rather than summed. `requestToOpen` is now measured from the request's own start whether it flew early or not, so the instrument no longer goes dark on exactly the path that works. `micDbfs` / `agcGainDb` report what the microphone actually delivered and what was done about it — a conversation that transcribes badly at -50 dBFS is a placement problem, not a model problem, and there was no way to tell before. `nameRepairs` lists every rewrite, because a repair that fires on ordinary speech has to be visible somewhere to be caught. Tuning any of the constants above without reading this line first is guessing, and guessing has already cost one round here.

## Getting the words right

Latency had three rounds of on-device measurement, broken down per link. Accuracy had none — and that asymmetry is itself the story of this section, because every decision below had been made in the direction that measurement could see.

- **480 ms of right context, not 320.** `target_streaming_delay_ms` is how much of the *following* audio Voxtral has before it commits to a word. Mistral's figure is that at 480 ms the realtime model matches their offline batch model (within 1-2 WER points on long- and short-form English); below that the curve turns down. This app shipped 320 for one release, bought with a comment calling the accuracy cost "marginal" — a number nobody had measured, spent to buy 160 ms that had been measured to the millisecond. 480 is the default now, with the 320 available in Settings for anyone who wants the time back. Push-to-talk sends the parameter too; it used to leave it to the server default, so the two modes transcribed under conditions that differed by an unknown amount.

- **The names are repaired, because the socket cannot be told about them.** Proper nouns carry no language-model support, so they are what an ASR gets wrong most — and Voxtral does not usually *mishear* them, it writes what it heard using ordinary orthography: "Cycy" comes back "Sisi", "Gonzalo" comes back "Gonsalo". Mistral does expose vocabulary biasing (`context_bias`, up to 100 terms) and a language hint, but only on the HTTP transcription endpoint, which wants a finished file; the realtime session accepts `audio_format` and `target_streaming_delay_ms` and rejects everything else as `extra_forbidden`. So the fix lives downstream: a phonetic key (`src/services/stt/nameRepair.ts`) maps spellings of the same sounds onto one another, and the transcript is rewritten towards a glossary of the people in the conversation.

  It matches *exactly* or not at all. Edit distance would catch more — "Alexandre" for "Alejandro" — and would also turn "Alejandra" into "Alejandro" and "el ala" into "el Ale". A repair that fires on ordinary speech poisons every turn, while a missed name is only the status quo, so the near misses go to the translator instead, which has the sentence in view. The same asymmetry curates the built-in name lists: any name that is also an ordinary word in a language it might be paired with is left out ("Rosa", "Mark", "Tomás" against Spanish "tú tomas", "Leon" against "león"), and the sentences that caught each one are in the test file.

  Repair happens on the way *in*, at the Utterance, not on the way out. Four things read the transcript — the live caption, the router, the speculative translation and the turn — and a translation sent on "Sisi" cannot be adopted by a turn that decided the words were "Cycy", so a repair applied late would throw away the head start on exactly the utterances the glossary exists for.

- **The translator is an interpreter, not a proofreader.** It is told that its input comes from an ASR under a few hundred milliseconds of lookahead, and that when a word is obviously a recognition error and the intended word is clear from context, the job is to translate what the speaker plainly meant. That licence needs a limit and evidence, and it has both: never invent facts, names or numbers, and translate literally when the meaning genuinely is not recoverable — judged against the last three exchanges, which are passed as context precisely so "obvious" has something to be obvious against. The glossary of names goes in the same prompt. Context is fenced as hard as the transcript: it is previous speech, so it carries the same injection surface, and it is marked never to be translated again or obeyed.

- **The microphone is levelled, and the level is logged.** Moving to `VOICE_RECOGNITION` removed the platform's gain control along with the noise suppressor that was eating quiet speech, which left the level at whatever a phone flat on a table gets from 40-60 cm away. `SpeechAgc` puts a slow, speech-gated normaliser in front of Voxtral only — the VAD and the seam wave keep the raw samples, because their thresholds are calibrated against the room and a meter with automatic gain is not a meter. It adapts only on frames loud enough to be speech (a gain that chases silence pumps), rises over ~1.2 s and falls fast, and caps each chunk's gain at whatever keeps that chunk's own peak inside full scale, so it cannot repeat the clipping that made the old source unusable.

  Being honest about it: digital gain does not improve signal-to-noise ratio — it lifts the noise by exactly as much as the speech. It puts the samples in the range the recogniser expects, which is worth having and is not a fix for a bad room. It is the one item here whose benefit is unproven, and `micDbfs`/`agcGainDb` in `[hf_turn]` plus `--agc on|off` in the bench are how to settle it rather than argue about it.

- **`scripts/voxtral-wer-bench.mjs` is the point of all of the above.** It replays real recordings through the real socket at wallclock speed and scores the transcripts against references, across delays, levelling and endpointing modes (`end` / `pause` — what the app did — / `settled` — what it does now). Every claim in this section is either a measurement Mistral published or a mechanism; the numbers for *this* app, in *this* room, come from there. Tuning any constant above without running it is guessing, and guessing is what this section is a record of.

## Key design decisions

1. **Cloud STT + cloud translation, OS-native TTS.** Voxtral handles the app's language list with quality far above a phone-bundled whisper-small, at a fraction of the install footprint — though not evenly: the realtime model is trained and evaluated on thirteen languages (en, es, fr, de, it, pt, nl, ru, ar, hi, zh, ja, ko), and the other nineteen the UI supports transcribe worse than that. The surface, the routing and the translation are built for all of them; the transcript is where the difference lands. TTS is OS-native — zero install, voices already on the device. The only on-device model is Silero VAD (2.3 MB ONNX in the APK), so hands-free turn detection never sends audio anywhere until someone is actually speaking.

2. **Streaming end to end.** Voxtral WS streams partials; Mistral SSE streams translation tokens; TTS queues sentences as they boundary-fire. There is no "wait until done" anywhere in the path.

3. **Fresh WebSocket per turn.** Idle WebSockets are subject to opaque server-side timeouts (30–90 s observed) and network-change drops on mobile. Each turn opens a new socket; TLS session reuse keeps subsequent handshakes at ~50–150 ms. (Hands-free keeps one session open and resets the utterance between turns instead.)

4. **Injection-resistant translation prompt.** Transcripts are wrapped as *speech to translate*, never as chat input — a speaker saying "ignore previous instructions" gets those words translated, not obeyed.

5. **API key in the OS keychain.** `react-native-keychain` keeps the key in the Android Keystore. It only ever appears in the `Authorization: Bearer …` header on requests to `api.mistral.ai`. No telemetry, no analytics.

   **Nothing unsendable ever becomes a header.** The key is the one string in the app that arrives entirely unexamined and goes straight into an HTTP header, where only printable ASCII is legal and Android's stack raises on anything else — from inside its own networking layer, below the reach of any `catch`. Reported as a crash on a device, and it took three builds and two wrong diagnoses to find: the diagnostics log had been pasted into the key field, and a few kilobytes of newlines and em dashes went out on the next request. The app closed with no error and no trail, because the failure was beneath the language. `isSendableKey` now gates all five places that build that header, and it checks only what it can know — printable ASCII, and a ceiling where no credential could live. Not a format check: no prefix, no length floor, no alphabet. A short wrong key is the server's to refuse, and guessing at the shape of a credential is how you lock someone out of a good one the day the issuer changes it. A key that cannot be sent is told apart from one the server rejected, because "check the paste" and "your key was revoked" send you to different places.

6. **Every failure is one plain sentence** on the half of the person who can act, in their language: connection dropped, key stopped working, rate limited, "I didn't catch that", mic permission, missing TTS voice, offline. Raw errors go to the diagnostics log only. Cancelled turns show nothing — user intent is not an error.

7. **The diagnostics log is written to survive the thing it is describing.** A release APK shows no red box and the phone is not attached to logcat, so a crash presents as the app silently closing and the log file is the only account of it. Entries persist to disk continuously (throttled, errors exempt) and reload on the next launch. Two failure modes shaped it. A *fatal JS* error used to leave nothing: its own log entry was written asynchronously while handing the error onward killed the process synchronously, so the entry describing the crash died with it — the global handler now waits for that write before handing off, with a 400 ms budget so a wedged disk cannot swallow a crash report. A *native* crash still leaves nothing, and nothing in JS can change that; the only defence is logging **before** each step that reaches into native code, so the last line names what was about to happen rather than what happened. That is why enabling hands-free narrates itself step by step.

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
├── app/            # Language metadata, shared types, name glossary
├── i18n/           # Per-half surface strings, 32 languages
├── store/          # Zustand: conversation, settings (persisted), network
├── services/
│   ├── pipeline/   # ConversationOrchestrator — both state machines, DI wiring
│   ├── stt/        # VoxtralRealtimeClient — WebSocket + frame protocol
│   │               # nameRepair — phonetic glossary repair
│   ├── translation/# MistralTranslator — SSE streaming + sentence chunks
│   ├── tts/        # react-native-tts wrapper
│   ├── audio/      # PCM capture, base64 codec, level normalisation
│   ├── vad/        # Silero VAD over onnxruntime
│   ├── network/    # Connectivity monitor + Mistral reachability probe
│   ├── auth/       # Key validation (GET /v1/models)
│   ├── storage/    # Keychain wrapper
│   └── log/        # In-memory ring buffer for the Logs screen
├── ui/             # Primitives, animations, theme, haptics
├── screens/        # Conversation, LanguagePair, Settings, Logs
└── navigation/
```
