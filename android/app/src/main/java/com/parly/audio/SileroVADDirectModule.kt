package com.parly.audio

import com.facebook.react.bridge.*

/**
 * React Native bridge module for Silero VAD via direct ONNX Runtime inference.
 *
 * Replaces [SileroVADModule] which uses sherpa-onnx's Vad() class (SIGABRTs on QNN build).
 * Same API contract so [SileroVADService.ts] needs only a module name change.
 *
 * Exposes:
 *   - initialize(modelPath)                — load the Silero ONNX model
 *   - acceptWaveform(samples, sampleRate)  — feed PCM, returns { isSpeechDetected, probability }
 *   - reset()                              — reset internal state
 *   - release()                            — free resources
 */
class SileroVADDirectModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ParlySileroVADDirect"

    private var vad: SileroVADDirect? = null

    @ReactMethod
    fun initialize(modelPath: String, promise: Promise) {
        try {
            vad?.release()
            vad = SileroVADDirect.create(
                modelPath = modelPath,
                threshold = 0.5f,
                windowSize = 512,
                sampleRate = 16000,
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SILERO_DIRECT_INIT_ERROR", "Failed to init Silero VAD direct: ${e.message}", e)
        }
    }

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
            result.putDouble("probability", detector.getProbability().toDouble())
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
