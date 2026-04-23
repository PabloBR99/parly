package com.parly.audio

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge module for native audio capture + playback.
 *
 * Eliminates the RN bridge bottleneck for audio data by running capture,
 * VAD, and playback entirely in native. Only events and speech segments
 * cross the bridge.
 *
 * Events emitted:
 *   - onNativeSpeechStart      VAD detected speech onset
 *   - onNativeSpeechEnd        VAD detected speech end
 *   - onNativeAudioChunk       Base64 PCM chunk (for streaming ASR in JS)
 *   - onNativeAudioLevel       RMS level for UI meter
 *   - onNativePlaybackComplete Playback finished
 */
class NativeAudioModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "NativeAudio"
    }

    override fun getName(): String = "ParlyNativeAudio"

    private val capture = NativeAudioCapture(reactContext)
    private val player = NativeAudioPlayer()
    private var emitAudioChunks = false

    init {
        capture.setListener(object : NativeAudioCapture.EventListener {
            override fun onSpeechStart() {
                sendEvent("onNativeSpeechStart", null)
            }

            override fun onSpeechEnd() {
                sendEvent("onNativeSpeechEnd", null)
            }

            override fun onAudioChunk(base64Pcm: String) {
                if (emitAudioChunks) {
                    val params = Arguments.createMap()
                    params.putString("data", base64Pcm)
                    sendEvent("onNativeAudioChunk", params)
                }
            }

            override fun onAudioLevel(rms: Float) {
                val params = Arguments.createMap()
                params.putDouble("level", rms.toDouble())
                sendEvent("onNativeAudioLevel", params)
            }
        })

        player.setListener(object : NativeAudioPlayer.PlaybackListener {
            override fun onPlaybackComplete() {
                sendEvent("onNativePlaybackComplete", null)
            }
        })
    }

    // ── Capture ─────────────────────────────────────────────────────────────

    @ReactMethod
    fun startCapture(emitChunks: Boolean, promise: Promise) {
        emitAudioChunks = emitChunks
        val success = capture.start()
        if (success) {
            promise.resolve(true)
        } else {
            promise.reject("CAPTURE_ERROR", "Failed to start native audio capture")
        }
    }

    @ReactMethod
    fun stopCapture(promise: Promise) {
        capture.stop()
        promise.resolve(true)
    }

    @ReactMethod
    fun pauseCapture(promise: Promise) {
        capture.pause()
        promise.resolve(true)
    }

    @ReactMethod
    fun resumeCapture(promise: Promise) {
        capture.resume()
        promise.resolve(true)
    }

    /**
     * Attach a Silero VAD instance to native capture using direct ONNX Runtime.
     * Bypasses sherpa-onnx's Vad() class which SIGABRTs on the QNN build.
     */
    @ReactMethod
    fun attachVad(modelPath: String, promise: Promise) {
        try {
            val vad = SileroVADDirect.create(
                modelPath = modelPath,
                threshold = 0.5f,
                windowSize = 512,
                sampleRate = 16000,
            )
            capture.setVad(vad)
            Log.i(TAG, "Attached Silero VAD (direct ONNX) to native capture")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to attach VAD: ${e.message}", e)
            promise.reject("VAD_ATTACH_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun detachVad(promise: Promise) {
        capture.setVad(null)
        promise.resolve(true)
    }

    /** Collect speech samples accumulated by native VAD as base64 PCM. */
    @ReactMethod
    fun collectSpeechChunks(promise: Promise) {
        val samples = capture.collectSpeechSamples()
        if (samples.isEmpty()) {
            promise.resolve("")
            return
        }

        // Convert Float32 back to Int16 PCM for WAV/STT
        val shorts = ShortArray(samples.size) { i ->
            (samples[i] * 32767f).toInt().coerceIn(-32768, 32767).toShort()
        }
        val bytes = ByteArray(shorts.size * 2)
        for (i in shorts.indices) {
            val s = shorts[i].toInt()
            bytes[i * 2] = (s and 0xFF).toByte()
            bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }

        promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    // ── Playback ────────────────────────────────────────────────────────────

    @ReactMethod
    fun playPCM(base64Data: String, sampleRate: Double, promise: Promise) {
        try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            player.playOnce(bytes, sampleRate.toInt())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("PLAYBACK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun startStreamPlayback(sampleRate: Double, promise: Promise) {
        try {
            player.startStream(sampleRate.toInt())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STREAM_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun feedStreamPCM(base64Data: String, promise: Promise) {
        try {
            player.feedPCMBase64(base64Data)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("FEED_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun finalizeStream(promise: Promise) {
        player.finalize()
        promise.resolve(true)
    }

    @ReactMethod
    fun stopPlayback(promise: Promise) {
        player.stop()
        promise.resolve(true)
    }

    // ── Events ──────────────────────────────────────────────────────────────

    private fun sendEvent(eventName: String, params: WritableMap?) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to send event $eventName: ${e.message}")
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitter
    }
}
