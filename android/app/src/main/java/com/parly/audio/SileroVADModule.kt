package com.parly.audio

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.TenVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig

/**
 * Native module that runs Silero VAD via the sherpa-onnx Vad class.
 *
 * Exposes:
 *   - initialize(modelPath) — load the Silero ONNX model
 *   - acceptWaveform(samples, sampleRate) — feed PCM Float32 samples, returns { isSpeechDetected }
 *   - reset() — reset internal state
 *   - release() — free resources
 */
class SileroVADModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    override fun getName(): String = "ParlySileroVAD"

    private var vad: Vad? = null

    @ReactMethod
    fun initialize(modelPath: String, promise: Promise) {
        try {
            vad?.release()

            val sileroConfig = SileroVadModelConfig(
                modelPath,   // model
                0.5f,        // threshold
                0.2f,        // minSilenceDuration (200ms)
                0.25f,       // minSpeechDuration
                512,         // windowSize (32ms at 16kHz)
                30.0f        // maxSpeechDuration
            )
            val config = VadModelConfig(
                sileroConfig,                    // sileroVadModelConfig
                TenVadModelConfig("", 0.5f, 0.1f, 0.1f, 256, 30.0f), // unused
                16000,                           // sampleRate
                1,                               // numThreads
                "",                              // provider
                false                            // debug
            )

            vad = Vad(reactApplicationContext.assets, config)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SILERO_INIT_ERROR", "Failed to initialize Silero VAD: ${e.message}", e)
        }
    }

    /**
     * Feed Float32 PCM samples to the VAD.
     * Returns whether speech is currently detected.
     */
    @ReactMethod
    fun acceptWaveform(samples: ReadableArray, sampleRate: Int, promise: Promise) {
        val detector = vad
        if (detector == null) {
            promise.reject("SILERO_NOT_INIT", "Silero VAD not initialized")
            return
        }

        try {
            val floatSamples = FloatArray(samples.size()) { i -> samples.getDouble(i).toFloat() }
            detector.acceptWaveform(floatSamples)

            val result = WritableNativeMap()
            result.putBoolean("isSpeechDetected", detector.isSpeechDetected())
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("SILERO_FEED_ERROR", "Feed error: ${e.message}", e)
        }
    }

    @ReactMethod
    fun reset(promise: Promise) {
        try {
            vad?.reset()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SILERO_RESET_ERROR", "Reset error: ${e.message}", e)
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        try {
            vad?.release()
            vad = null
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SILERO_RELEASE_ERROR", "Release error: ${e.message}", e)
        }
    }
}
