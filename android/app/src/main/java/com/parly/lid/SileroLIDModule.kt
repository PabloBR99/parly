package com.parly.lid

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import com.facebook.react.bridge.*
import java.io.File
import java.nio.FloatBuffer

/**
 * React Native bridge for Silero Language Identification (95 languages).
 *
 * Uses the lang_classifier_95.onnx model via ONNX Runtime Java API directly.
 * Input: raw 16kHz float32 PCM audio (normalized to [-1, 1]).
 * Output: top-N language predictions with confidence scores.
 *
 * Model tensor interface:
 *   Input:  "input"  — float32 [batch, samples]
 *   Output: "output" — float32 [batch, 95] (logits, apply softmax for probabilities)
 */
class SileroLIDModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ParlySileroLID"

    private var session: OrtSession? = null
    private var env: OrtEnvironment? = null
    private var langDict: Map<Int, String> = emptyMap() // index → language code

    @ReactMethod
    fun initialize(modelPath: String, langDictPath: String, promise: Promise) {
        try {
            release()

            // Parse lang dict: {"0": "fr, French", "19": "es, Spanish, Castilian", ...}
            val dictJson = File(langDictPath).readText()
            langDict = parseLangDict(dictJson)

            env = OrtEnvironment.getEnvironment()
            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(2)
            }
            session = env!!.createSession(modelPath, opts)

            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("LID_INIT_ERROR", "Failed to init Silero LID: ${e.message}", e)
        }
    }

    /**
     * Identify the spoken language from raw PCM audio samples.
     *
     * @param samples Float32 PCM audio at 16kHz, normalized to [-1, 1]
     * @param topN    Number of top predictions to return
     * @return Array of {language, confidence} sorted by confidence descending
     */
    @ReactMethod
    fun identifyLanguage(samples: ReadableArray, topN: Int, promise: Promise) {
        val sess = session
        val ortEnv = env
        if (sess == null || ortEnv == null) {
            promise.reject("LID_NOT_INIT", "Silero LID not initialized")
            return
        }

        try {
            val numSamples = samples.size()
            val floatSamples = FloatArray(numSamples) { i -> samples.getDouble(i).toFloat() }

            val predictions = runInference(sess, ortEnv, floatSamples, topN)

            val result = WritableNativeArray()
            for ((lang, conf) in predictions) {
                val entry = WritableNativeMap()
                entry.putString("language", lang)
                entry.putDouble("confidence", conf.toDouble())
                result.pushMap(entry)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("LID_INFERENCE_ERROR", "LID inference error: ${e.message}", e)
        }
    }

    /**
     * Identify spoken language from a WAV file (16kHz mono PCM16).
     * More efficient than passing samples over the bridge.
     */
    @ReactMethod
    fun identifyLanguageFromFile(wavPath: String, topN: Int, promise: Promise) {
        val sess = session
        val ortEnv = env
        if (sess == null || ortEnv == null) {
            promise.reject("LID_NOT_INIT", "Silero LID not initialized")
            return
        }

        try {
            val samples = readWavAsFloat32(wavPath)
            val predictions = runInference(sess, ortEnv, samples, topN)

            val result = WritableNativeArray()
            for ((lang, conf) in predictions) {
                val entry = WritableNativeMap()
                entry.putString("language", lang)
                entry.putDouble("confidence", conf.toDouble())
                result.pushMap(entry)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("LID_FILE_ERROR", "LID file error: ${e.message}", e)
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        try {
            release()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("LID_RELEASE_ERROR", "Release error: ${e.message}", e)
        }
    }

    private fun release() {
        session?.close()
        session = null
        // OrtEnvironment is a shared singleton — do not close it
        env = null
    }

    private fun runInference(
        sess: OrtSession,
        ortEnv: OrtEnvironment,
        samples: FloatArray,
        topN: Int,
    ): List<Pair<String, Float>> {
        // Input tensor: [1, num_samples]
        val inputShape = longArrayOf(1, samples.size.toLong())
        val inputTensor = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(samples), inputShape)

        val results = sess.run(mapOf("input" to inputTensor))
        inputTensor.close()

        // Output tensor: [1, 95] logits
        @Suppress("UNCHECKED_CAST")
        val logits = (results[0].value as Array<FloatArray>)[0]
        results.close()

        // Softmax to convert logits → probabilities
        val probs = softmax(logits)

        // Get top N predictions
        val indexed = probs.mapIndexed { i, p -> i to p }
            .sortedByDescending { it.second }
            .take(topN)

        return indexed.map { (idx, prob) ->
            val langCode = langDict[idx] ?: "unk"
            langCode to prob
        }
    }

    private fun softmax(logits: FloatArray): FloatArray {
        val max = logits.max()
        val exps = FloatArray(logits.size) { i -> Math.exp((logits[i] - max).toDouble()).toFloat() }
        val sum = exps.sum()
        return FloatArray(exps.size) { i -> exps[i] / sum }
    }

    /** Read a 16kHz mono PCM16 WAV file and return Float32 samples in [-1, 1]. */
    private fun readWavAsFloat32(wavPath: String): FloatArray {
        val file = File(wavPath)
        val bytes = file.readBytes()
        // Skip 44-byte WAV header → PCM16 data
        val headerSize = 44
        val pcmBytes = bytes.size - headerSize
        val numSamples = pcmBytes / 2
        val samples = FloatArray(numSamples)
        for (i in 0 until numSamples) {
            val offset = headerSize + i * 2
            val lo = bytes[offset].toInt() and 0xFF
            val hi = bytes[offset + 1].toInt()
            val sample = (hi shl 8) or lo
            samples[i] = sample / 32768f
        }
        return samples
    }

    private fun parseLangDict(json: String): Map<Int, String> {
        // Simple JSON parsing: {"0": "fr, French", "19": "es, Spanish, Castilian", ...}
        val map = mutableMapOf<Int, String>()
        val entries = json.trim().removePrefix("{").removeSuffix("}")
        for (entry in entries.split("\",")) {
            val parts = entry.split(":")
            if (parts.size < 2) continue
            val key = parts[0].trim().trim('"').toIntOrNull() ?: continue
            val value = parts.subList(1, parts.size).joinToString(":").trim().trim('"').trim()
            // Extract just the language code (first part before comma)
            val langCode = value.split(",")[0].trim()
            map[key] = langCode
        }
        return map
    }
}
