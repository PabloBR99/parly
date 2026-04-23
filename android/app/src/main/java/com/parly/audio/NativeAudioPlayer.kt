package com.parly.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native audio player using AudioTrack in streaming mode.
 *
 * Supports two modes:
 * 1. One-shot: play a complete PCM buffer and resolve when done.
 * 2. Streaming: incrementally feed PCM chunks for real-time TTS output,
 *    reducing time-to-first-audio vs buffering the full utterance.
 */
class NativeAudioPlayer {

    companion object {
        private const val TAG = "NativeAudioPlayer"
        private const val DEFAULT_SAMPLE_RATE = 24000 // TTS output rate
    }

    interface PlaybackListener {
        fun onPlaybackComplete()
    }

    @Volatile
    private var audioTrack: AudioTrack? = null
    private var playbackThread: Thread? = null
    private val isPlaying = AtomicBoolean(false)
    private val isStopping = AtomicBoolean(false)
    private var listener: PlaybackListener? = null

    // Streaming queue
    private val pcmQueue = ConcurrentLinkedQueue<ShortArray>()
    private val streamingActive = AtomicBoolean(false)
    private val streamingFinalized = AtomicBoolean(false)

    fun setListener(l: PlaybackListener?) {
        this.listener = l
    }

    // ── One-shot playback ───────────────────────────────────────────────────

    /**
     * Play a complete PCM buffer. Returns when playback finishes.
     * PCM data: 16-bit signed LE mono at [sampleRate].
     */
    fun playOnce(pcmBytes: ByteArray, sampleRate: Int = DEFAULT_SAMPLE_RATE) {
        stop()

        val shorts = ShortArray(pcmBytes.size / 2)
        ByteBuffer.wrap(pcmBytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)

        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )

        val track = createTrack(sampleRate, maxOf(minBuf, pcmBytes.size))
        audioTrack = track
        isPlaying.set(true)

        track.setNotificationMarkerPosition(shorts.size)
        track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onPeriodicNotification(t: AudioTrack) {}
            override fun onMarkerReached(t: AudioTrack) {
                isPlaying.set(false)
                // Use compareAndSet pattern: only release if we still own this track
                // (stop() on the RN thread may have already released it)
                if (audioTrack === t) {
                    audioTrack = null
                    try {
                        t.stop()
                        t.release()
                    } catch (_: Exception) {}
                }
                listener?.onPlaybackComplete()
            }
        })

        track.play()
        track.write(shorts, 0, shorts.size)
    }

    // ── Streaming playback ──────────────────────────────────────────────────

    /**
     * Start streaming mode. Call feedPCM() to push chunks, then finalize().
     * Audio begins playing as soon as the first chunk arrives.
     */
    fun startStream(sampleRate: Int = DEFAULT_SAMPLE_RATE) {
        stop()

        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )

        val track = createTrack(sampleRate, minBuf * 4)
        audioTrack = track
        isPlaying.set(true)
        streamingActive.set(true)
        streamingFinalized.set(false)
        pcmQueue.clear()

        track.play()

        playbackThread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            streamingLoop(track)
        }, "NativeAudioPlayer-Stream").apply { start() }
    }

    /** Feed a PCM chunk to the streaming player. */
    fun feedPCM(pcmShorts: ShortArray) {
        if (!streamingActive.get()) return
        pcmQueue.add(pcmShorts)
    }

    /** Feed base64-encoded PCM data to the streaming player. */
    fun feedPCMBase64(base64Data: String) {
        val bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT)
        val shorts = ShortArray(bytes.size / 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
        feedPCM(shorts)
    }

    /** Signal no more chunks will arrive. Playback continues until queue drains. */
    fun finalize() {
        streamingFinalized.set(true)
    }

    fun stop() {
        isStopping.set(true)
        streamingActive.set(false)
        streamingFinalized.set(true)
        pcmQueue.clear()

        try {
            playbackThread?.join(500)
        } catch (_: InterruptedException) {}
        playbackThread = null

        // Atomically take the track reference — prevents double-release with callback
        val track = audioTrack
        audioTrack = null
        track?.let {
            try {
                it.pause()
                it.flush()
                it.stop()
            } catch (_: Exception) {}
            it.release()
        }
        isPlaying.set(false)
        isStopping.set(false)
    }

    val active: Boolean get() = isPlaying.get()

    // ── Internal ────────────────────────────────────────────────────────────

    private fun streamingLoop(track: AudioTrack) {
        try {
            while (streamingActive.get() || pcmQueue.isNotEmpty()) {
                val chunk = pcmQueue.poll()
                if (chunk != null) {
                    track.write(chunk, 0, chunk.size)
                } else if (streamingFinalized.get() && pcmQueue.isEmpty()) {
                    break
                } else {
                    // No data yet — short sleep to avoid busy-wait
                    Thread.sleep(5)
                }
            }

            // Wait for AudioTrack to finish playing buffered data
            if (!isStopping.get()) {
                // Small delay for remaining audio to play out
                Thread.sleep(100)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Streaming loop error: ${e.message}", e)
        } finally {
            isPlaying.set(false)
            streamingActive.set(false)
            if (!isStopping.get()) {
                try {
                    track.stop()
                    track.release()
                } catch (_: Exception) {}
                audioTrack = null
                listener?.onPlaybackComplete()
            }
        }
    }

    private fun createTrack(sampleRate: Int, bufferSize: Int): AudioTrack {
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }
}
