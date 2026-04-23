package com.parly.audio

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native audio capture using Android's AudioRecord API.
 *
 * Captures 16kHz mono PCM and feeds it directly to Silero VAD in native,
 * eliminating the RN bridge crossing for audio data (~5-12ms per 30ms frame).
 *
 * Only VAD events (speech_start, speech_end) and accumulated speech chunks
 * cross the bridge — not continuous audio data.
 */
class NativeAudioCapture(private val context: ReactApplicationContext) {

    companion object {
        private const val TAG = "NativeAudioCapture"
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        // VOICE_COMMUNICATION: AGC + AEC + NS — best for conversation
        private const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_COMMUNICATION

        /** VAD window size for Silero — 512 samples = 32ms at 16kHz. */
        private const val VAD_WINDOW_SIZE = 512
        /** Capture buffer: 20ms of audio at 16kHz mono 16-bit. */
        private const val CAPTURE_BUFFER_SAMPLES = 320 // 20ms
    }

    /** Listener for VAD and audio events. */
    interface EventListener {
        fun onSpeechStart()
        fun onSpeechEnd()
        /** Called with base64-encoded PCM chunk (for streaming ASR bridge). */
        fun onAudioChunk(base64Pcm: String)
        fun onAudioLevel(rms: Float)
    }

    private var audioRecord: AudioRecord? = null
    private var captureThread: Thread? = null
    private val isCapturing = AtomicBoolean(false)
    private val isPaused = AtomicBoolean(false)
    private var listener: EventListener? = null

    // VAD integration — uses VadProvider interface (SileroVADDirect or any future impl)
    private var vad: VadProvider? = null
    private var vadActive = false

    // VAD state machine (mirrors SileroVADService.ts logic)
    private enum class VadState { SILENCE, MAYBE_SPEECH, SPEECH, MAYBE_SILENCE }
    private var vadState = VadState.SILENCE
    private var stateEnteredAt = 0L
    private val speechChunks = ConcurrentLinkedQueue<FloatArray>()
    private val speechSampleCount = AtomicInteger(0)

    // Timing constants matching SileroVADService.ts
    private val speechOnsetMs = 200L
    private val silenceTimeoutMs = 900L
    private val minSegmentSamples = (SAMPLE_RATE * 0.8).toInt() // 0.8s min

    // Ring buffer for pre-roll (400ms)
    private val preRollBuffer = ArrayDeque<FloatArray>()
    private val preRollMaxSamples = (SAMPLE_RATE * 0.4).toInt() // 400ms
    private var preRollCurrentSamples = 0

    fun setVad(vadInstance: VadProvider?) {
        this.vad = vadInstance
        this.vadActive = vadInstance != null
    }

    fun setListener(l: EventListener?) {
        this.listener = l
    }

    fun start(): Boolean {
        if (isCapturing.get()) return true

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.e(TAG, "RECORD_AUDIO permission not granted")
            return false
        }

        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        val bufferSize = maxOf(minBufferSize * 2, CAPTURE_BUFFER_SAMPLES * 2 * 4) // 2 bytes per sample, 4x

        try {
            audioRecord = AudioRecord(
                AUDIO_SOURCE, SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to initialize")
                audioRecord?.release()
                audioRecord = null
                return false
            }

            resetVadState()
            isCapturing.set(true)
            isPaused.set(false)
            audioRecord?.startRecording()

            captureThread = Thread({
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
                captureLoop()
            }, "NativeAudioCapture").apply { start() }

            Log.i(TAG, "Started native audio capture at ${SAMPLE_RATE}Hz")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start capture: ${e.message}", e)
            audioRecord?.release()
            audioRecord = null
            isCapturing.set(false)
            return false
        }
    }

    fun stop() {
        isCapturing.set(false)
        try {
            captureThread?.join(1000)
        } catch (_: InterruptedException) {}
        captureThread = null

        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null

        resetVadState()
        Log.i(TAG, "Stopped native audio capture")
    }

    fun pause() {
        isPaused.set(true)
    }

    fun resume() {
        resetVadState()
        vad?.reset()
        isPaused.set(false)
    }

    val isActive: Boolean get() = isCapturing.get()

    // ── Capture loop ────────────────────────────────────────────────────────

    private fun captureLoop() {
        val shortBuffer = ShortArray(CAPTURE_BUFFER_SAMPLES)

        while (isCapturing.get()) {
            val read = audioRecord?.read(shortBuffer, 0, CAPTURE_BUFFER_SAMPLES) ?: -1
            if (read <= 0) continue

            // Convert Int16 to Float32 [-1, 1]
            val floatSamples = FloatArray(read) { shortBuffer[it].toFloat() / 32768f }

            // Always update pre-roll ring buffer
            updatePreRoll(floatSamples)

            if (isPaused.get()) continue

            // Compute RMS for audio level meter
            val rms = computeRms(floatSamples)
            listener?.onAudioLevel(rms)

            // Send base64 chunk to JS for streaming ASR (if listener wants it)
            val base64 = shortArrayToBase64(shortBuffer, read)
            listener?.onAudioChunk(base64)

            // Feed VAD if available
            if (vadActive && vad != null) {
                processVad(floatSamples)
            }
        }
    }

    // ── VAD processing ──────────────────────────────────────────────────────

    private fun processVad(samples: FloatArray) {
        val detector = vad ?: return

        // Feed all samples to VAD
        detector.acceptWaveform(samples)
        val isSpeech = detector.isSpeechDetected()
        val now = System.currentTimeMillis()

        when (vadState) {
            VadState.SILENCE -> {
                if (isSpeech) {
                    vadState = VadState.MAYBE_SPEECH
                    stateEnteredAt = now
                    // Capture pre-roll
                    for (chunk in preRollBuffer) {
                        speechChunks.add(chunk.copyOf())
                        speechSampleCount.addAndGet(chunk.size)
                    }
                    speechChunks.add(samples.copyOf())
                    speechSampleCount.addAndGet(samples.size)
                }
            }
            VadState.MAYBE_SPEECH -> {
                speechChunks.add(samples.copyOf())
                speechSampleCount.addAndGet(samples.size)
                if (!isSpeech) {
                    vadState = VadState.SILENCE
                    speechChunks.clear()
                    speechSampleCount.set(0)
                } else if (now - stateEnteredAt >= speechOnsetMs) {
                    vadState = VadState.SPEECH
                    listener?.onSpeechStart()
                }
            }
            VadState.SPEECH -> {
                speechChunks.add(samples.copyOf())
                speechSampleCount.addAndGet(samples.size)
                if (!isSpeech) {
                    vadState = VadState.MAYBE_SILENCE
                    stateEnteredAt = now
                }
            }
            VadState.MAYBE_SILENCE -> {
                speechChunks.add(samples.copyOf())
                speechSampleCount.addAndGet(samples.size)
                if (isSpeech) {
                    vadState = VadState.SPEECH
                } else if (now - stateEnteredAt >= silenceTimeoutMs) {
                    vadState = VadState.SILENCE
                    if (speechSampleCount.get() >= minSegmentSamples) {
                        listener?.onSpeechEnd()
                    } else {
                        Log.d(TAG, "Discarding short segment: ${speechSampleCount.get()} < $minSegmentSamples samples")
                    }
                    speechChunks.clear()
                    speechSampleCount.set(0)
                }
            }
        }
    }

    /** Collect accumulated speech chunks as a single Float32 array. */
    fun collectSpeechSamples(): FloatArray {
        val allChunks = mutableListOf<FloatArray>()
        while (speechChunks.isNotEmpty()) {
            speechChunks.poll()?.let { allChunks.add(it) }
        }
        speechSampleCount.set(0)

        val totalSize = allChunks.sumOf { it.size }
        val result = FloatArray(totalSize)
        var offset = 0
        for (chunk in allChunks) {
            chunk.copyInto(result, offset)
            offset += chunk.size
        }
        return result
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun updatePreRoll(samples: FloatArray) {
        preRollBuffer.addLast(samples.copyOf())
        preRollCurrentSamples += samples.size

        while (preRollCurrentSamples > preRollMaxSamples && preRollBuffer.size > 1) {
            val removed = preRollBuffer.removeFirst()
            preRollCurrentSamples -= removed.size
        }
    }

    private fun resetVadState() {
        vadState = VadState.SILENCE
        stateEnteredAt = 0
        speechChunks.clear()
        speechSampleCount.set(0)
        preRollBuffer.clear()
        preRollCurrentSamples = 0
    }

    private fun computeRms(samples: FloatArray): Float {
        if (samples.isEmpty()) return 0f
        var sum = 0f
        for (s in samples) sum += s * s
        return kotlin.math.sqrt(sum / samples.size)
    }

    private fun shortArrayToBase64(shorts: ShortArray, count: Int): String {
        val bytes = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = shorts[i].toInt()
            bytes[i * 2] = (s and 0xFF).toByte()
            bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    }
}
