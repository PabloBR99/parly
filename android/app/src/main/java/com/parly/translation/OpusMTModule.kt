package com.parly.translation

import android.util.Log
import ai.onnxruntime.*
import com.facebook.react.bridge.*
import java.io.File
import java.nio.LongBuffer

/**
 * Native module for Helsinki-NLP MarianMT ONNX INT8 translation.
 *
 * Each model directory contains:
 *   - encoder_model_quantized.onnx
 *   - decoder_model_quantized.onnx
 *   - source.spm  (SentencePiece tokenizer for source language)
 *   - target.spm  (SentencePiece tokenizer for target language)
 *   - vocab.json  (shared vocabulary)
 *   - config.json (model config with decoder_start_token_id, eos_token_id, etc.)
 *
 * Exposes:
 *   - loadModel(modelDir)     — load encoder + decoder ONNX sessions and SPM tokenizers
 *   - translate(text, modelDir) — tokenize, encode, greedy-decode, detokenize
 *   - releaseModel(modelDir)  — free ONNX sessions for a model
 *   - releaseAll()            — free all loaded models
 */
class OpusMTModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ParlyOpusMT"

    companion object {
        private const val TAG = "OpusMT"
        private const val MAX_OUTPUT_TOKENS = 512
        private const val PAD_TOKEN_ID = 58100L  // MarianMT default
        private const val EOS_TOKEN_ID = 0L       // </s> in MarianMT vocab
        private const val DECODER_START_TOKEN_ID = 58100L // MarianMT pad as BOS
    }

    private data class LoadedModel(
        val encoder: OrtSession,
        val decoder: OrtSession,
        val sourceTokenizer: SentencePieceTokenizer,
        val targetTokenizer: SentencePieceTokenizer,
        val vocab: Map<String, Long>,
        val reverseVocab: Map<Long, String>,
        val eosTokenId: Long,
        val decoderStartTokenId: Long,
    )

    // Lazy: sherpa-onnx bundles a QNN build of ONNX Runtime whose libonnxruntime.so
    // does not export OrtGetApiBase, so the Java API crashes on System.loadLibrary.
    // We defer initialization until an actual translate() call, and catch the error
    // so the app starts even if the Java ONNX Runtime bridge is broken.
    private var env: OrtEnvironment? = null
    private var ortUnavailable = false
    private val models = mutableMapOf<String, LoadedModel>()

    private fun getOrCreateEnv(): OrtEnvironment? {
        if (ortUnavailable) return null
        if (env != null) return env
        return try {
            val e = OrtEnvironment.getEnvironment()
            env = e
            e
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "ONNX Runtime Java bridge unavailable (QNN build lacks OrtGetApiBase): ${e.message}")
            ortUnavailable = true
            null
        } catch (e: ExceptionInInitializerError) {
            Log.e(TAG, "ONNX Runtime initialization failed: ${e.message}")
            ortUnavailable = true
            null
        }
    }

    // ── Load / Release ──────────────────────────────────────────────────────

    @ReactMethod
    fun loadModel(modelDir: String, promise: Promise) {
        try {
            if (models.containsKey(modelDir)) {
                promise.resolve(true)
                return
            }

            val ortEnv = getOrCreateEnv()
            if (ortEnv == null) {
                promise.reject("ORT_UNAVAILABLE",
                    "ONNX Runtime Java API unavailable — OpusMT disabled, using ML Kit fallback")
                return
            }

            val dir = File(modelDir)
            if (!dir.isDirectory) {
                promise.reject("MODEL_NOT_FOUND", "Model directory not found: $modelDir")
                return
            }

            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(2)
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            }

            val encoderPath = File(dir, "encoder_model_quantized.onnx").absolutePath
            val decoderPath = File(dir, "decoder_model_quantized.onnx").absolutePath

            val encoder = ortEnv.createSession(encoderPath, opts)
            val decoder = ortEnv.createSession(decoderPath, opts)

            val sourceTokenizer = SentencePieceTokenizer(File(dir, "source.spm").absolutePath)
            val targetTokenizer = SentencePieceTokenizer(File(dir, "target.spm").absolutePath)

            // Load vocab.json for id↔token mapping
            val vocabFile = File(dir, "vocab.json")
            val vocabText = vocabFile.readText()
            val vocab = parseVocabJson(vocabText)
            val reverseVocab = vocab.entries.associate { (k, v) -> v to k }

            // Read config for special token IDs
            val configFile = File(dir, "config.json")
            var eosId = EOS_TOKEN_ID
            var decStartId = DECODER_START_TOKEN_ID
            if (configFile.exists()) {
                val configText = configFile.readText()
                eosId = extractJsonLong(configText, "eos_token_id") ?: EOS_TOKEN_ID
                decStartId = extractJsonLong(configText, "decoder_start_token_id")
                    ?: extractJsonLong(configText, "pad_token_id")
                    ?: DECODER_START_TOKEN_ID
            }

            models[modelDir] = LoadedModel(
                encoder = encoder,
                decoder = decoder,
                sourceTokenizer = sourceTokenizer,
                targetTokenizer = targetTokenizer,
                vocab = vocab,
                reverseVocab = reverseVocab,
                eosTokenId = eosId,
                decoderStartTokenId = decStartId,
            )

            Log.i(TAG, "Loaded model from $modelDir (vocab=${vocab.size})")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load model: ${e.message}", e)
            promise.reject("OPUS_LOAD_ERROR", "Failed to load OpusMT model: ${e.message}", e)
        }
    }

    @ReactMethod
    fun releaseModel(modelDir: String, promise: Promise) {
        try {
            models.remove(modelDir)?.let { model ->
                model.encoder.close()
                model.decoder.close()
                model.sourceTokenizer.close()
                model.targetTokenizer.close()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPUS_RELEASE_ERROR", "Release error: ${e.message}", e)
        }
    }

    @ReactMethod
    fun releaseAll(promise: Promise) {
        try {
            for ((_, model) in models) {
                model.encoder.close()
                model.decoder.close()
                model.sourceTokenizer.close()
                model.targetTokenizer.close()
            }
            models.clear()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPUS_RELEASE_ERROR", "Release all error: ${e.message}", e)
        }
    }

    // ── Translate ───────────────────────────────────────────────────────────

    @ReactMethod
    fun translate(text: String, modelDir: String, promise: Promise) {
        val model = models[modelDir]
        if (model == null) {
            promise.reject("MODEL_NOT_LOADED", "Model not loaded: $modelDir. Call loadModel() first.")
            return
        }

        try {
            val result = translateInternal(text, model)
            promise.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "Translation error: ${e.message}", e)
            promise.reject("OPUS_TRANSLATE_ERROR", "Translation failed: ${e.message}", e)
        }
    }

    @ReactMethod
    fun isModelLoaded(modelDir: String, promise: Promise) {
        promise.resolve(models.containsKey(modelDir))
    }

    // ── Internal translation logic ──────────────────────────────────────────

    private fun translateInternal(text: String, model: LoadedModel): String {
        val ortEnv = env ?: throw IllegalStateException("OrtEnvironment not initialized")

        // 1. Tokenize source text with SentencePiece
        val sourceTokens = model.sourceTokenizer.encode(text)

        // 2. Convert tokens to IDs via vocab
        val inputIds = LongArray(sourceTokens.size + 1) // +1 for EOS
        for (i in sourceTokens.indices) {
            inputIds[i] = model.vocab[sourceTokens[i]] ?: model.vocab["<unk>"] ?: 0L
        }
        inputIds[sourceTokens.size] = model.eosTokenId

        val seqLen = inputIds.size.toLong()
        val attentionMask = LongArray(inputIds.size) { 1L }

        // 3. Run encoder
        val inputIdsTensor = OnnxTensor.createTensor(
            ortEnv, LongBuffer.wrap(inputIds), longArrayOf(1, seqLen)
        )
        val attentionMaskTensor = OnnxTensor.createTensor(
            ortEnv, LongBuffer.wrap(attentionMask), longArrayOf(1, seqLen)
        )

        val encoderInputs = mapOf(
            "input_ids" to inputIdsTensor,
            "attention_mask" to attentionMaskTensor,
        )

        val encoderResult = model.encoder.run(encoderInputs)

        try {
            val encoderHiddenStates = encoderResult.get(0) as OnnxTensor

            // 4. Greedy decode
            val outputTokenIds = mutableListOf(model.decoderStartTokenId)

            for (step in 0 until MAX_OUTPUT_TOKENS) {
                val decoderInputIds = LongArray(outputTokenIds.size) { outputTokenIds[it] }
                val decoderSeqLen = decoderInputIds.size.toLong()

                val decoderInputTensor = OnnxTensor.createTensor(
                    ortEnv, LongBuffer.wrap(decoderInputIds), longArrayOf(1, decoderSeqLen)
                )

                // Decoder attention mask: all ones
                val decoderAttentionMask = LongArray(decoderInputIds.size) { 1L }
                val decoderAttentionTensor = OnnxTensor.createTensor(
                    ortEnv, LongBuffer.wrap(decoderAttentionMask), longArrayOf(1, decoderSeqLen)
                )

                val decoderInputs = mutableMapOf<String, OnnxTensor>(
                    "input_ids" to decoderInputTensor,
                    "encoder_attention_mask" to attentionMaskTensor,
                    "encoder_hidden_states" to encoderHiddenStates,
                )

                // Some models expect decoder_attention_mask
                try {
                    val inputNames = model.decoder.inputNames
                    if (inputNames.contains("decoder_attention_mask")) {
                        decoderInputs["decoder_attention_mask"] = decoderAttentionTensor
                    }
                } catch (_: Exception) {
                    // Ignore — skip optional input
                }

                val decoderResult = model.decoder.run(decoderInputs)
                try {
                    val logits = decoderResult.get(0) as OnnxTensor

                    // Get logits for the last token position
                    val logitsShape = logits.info.shape // [1, seq_len, vocab_size]
                    val vocabSize = logitsShape[2].toInt()
                    val logitsData = logits.floatBuffer

                    // Offset to last token's logits
                    val lastTokenOffset = (decoderSeqLen.toInt() - 1) * vocabSize
                    var bestId = 0L
                    var bestLogit = Float.NEGATIVE_INFINITY
                    for (v in 0 until vocabSize) {
                        val l = logitsData.get(lastTokenOffset + v)
                        if (l > bestLogit) {
                            bestLogit = l
                            bestId = v.toLong()
                        }
                    }

                    if (bestId == model.eosTokenId) break
                    outputTokenIds.add(bestId)
                } finally {
                    decoderInputTensor.close()
                    decoderAttentionTensor.close()
                    decoderResult.close()
                }
            }

            // 5. Detokenize: convert IDs back to tokens, then SentencePiece decode
            val outputTokens = outputTokenIds
                .drop(1) // skip BOS
                .mapNotNull { model.reverseVocab[it] }

            return model.targetTokenizer.decode(outputTokens)
        } finally {
            // Always clean up encoder tensors — even if decoder loop throws
            inputIdsTensor.close()
            attentionMaskTensor.close()
            encoderResult.close()
        }
    }

    // ── JSON parsing (minimal, avoids external dependencies) ────────────────

    /** Parse a flat { "token": id, ... } JSON object into a map. */
    private fun parseVocabJson(json: String): Map<String, Long> {
        val result = mutableMapOf<String, Long>()
        // Simple regex for "key": number entries
        val pattern = Regex("\"([^\"\\\\]*(?:\\\\.[^\"\\\\]*)*)\"\\s*:\\s*(-?\\d+)")
        for (match in pattern.findAll(json)) {
            val key = match.groupValues[1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\/", "/")
                .replace("\\n", "\n")
                .replace("\\t", "\t")
            val value = match.groupValues[2].toLongOrNull() ?: continue
            result[key] = value
        }
        return result
    }

    /** Extract a numeric value from JSON by key. */
    private fun extractJsonLong(json: String, key: String): Long? {
        val pattern = Regex("\"$key\"\\s*:\\s*(-?\\d+)")
        return pattern.find(json)?.groupValues?.get(1)?.toLongOrNull()
    }
}
