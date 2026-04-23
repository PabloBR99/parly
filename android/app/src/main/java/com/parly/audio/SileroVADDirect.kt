package com.parly.audio

import android.util.Log
import ai.onnxruntime.*
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Silero VAD using ONNX Runtime Java API directly.
 *
 * Bypasses sherpa-onnx's Vad() class which SIGABRTs on the QNN build
 * (pthread_mutex_lock on destroyed mutex). Uses the same proven ONNX Runtime
 * direct-inference pattern as OpusMTModule.kt.
 *
 * Silero VAD ONNX graph:
 *   Inputs:  input [1, window_size]  Float32 PCM
 *            sr    [1]               Int64 sample rate
 *            h     [2, 1, 64]        Float32 LSTM hidden state
 *            c     [2, 1, 64]        Float32 LSTM cell state
 *   Outputs: output [1, 1]           Float32 speech probability
 *            hn     [2, 1, 64]       Float32 updated hidden
 *            cn     [2, 1, 64]       Float32 updated cell
 */
class SileroVADDirect private constructor(
    private val session: OrtSession,
    private val env: OrtEnvironment,
    private val threshold: Float,
    private val windowSize: Int,
    private val sampleRate: Int,
) : VadProvider {

    companion object {
        private const val TAG = "SileroVADDirect"
        private const val STATE_DIM = 64
        private const val STATE_LAYERS = 2

        /**
         * Create a SileroVADDirect instance from a model file path.
         * @throws IllegalStateException if ONNX Runtime is unavailable
         */
        fun create(
            modelPath: String,
            threshold: Float = 0.5f,
            windowSize: Int = 512,
            sampleRate: Int = 16000,
        ): SileroVADDirect {
            val env = try {
                OrtEnvironment.getEnvironment()
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "ONNX Runtime Java API unavailable (QNN build lacks OrtGetApiBase): ${e.message}", e
                )
            } catch (e: ExceptionInInitializerError) {
                throw IllegalStateException(
                    "ONNX Runtime initialization failed: ${e.message}", e
                )
            }

            val file = File(modelPath)
            if (!file.exists()) {
                throw IllegalArgumentException("Model file not found: $modelPath")
            }

            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(1)
                setInterOpNumThreads(1)
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            }

            val session = env.createSession(modelPath, opts)
            Log.i(TAG, "Loaded Silero VAD from $modelPath (window=$windowSize, threshold=$threshold)")

            return SileroVADDirect(session, env, threshold, windowSize, sampleRate)
        }
    }

    // LSTM hidden and cell states — updated after each inference call
    private var hState = FloatArray(STATE_LAYERS * 1 * STATE_DIM)
    private var cState = FloatArray(STATE_LAYERS * 1 * STATE_DIM)

    // Internal buffer for accumulating samples to window_size
    private var buffer = FloatArray(windowSize)
    private var bufferPos = 0

    // Last speech probability from inference
    private var lastProbability = 0f

    override fun acceptWaveform(samples: FloatArray) {
        var offset = 0
        while (offset < samples.size) {
            val remaining = windowSize - bufferPos
            val toCopy = minOf(remaining, samples.size - offset)
            System.arraycopy(samples, offset, buffer, bufferPos, toCopy)
            bufferPos += toCopy
            offset += toCopy

            if (bufferPos >= windowSize) {
                runInference(buffer)
                bufferPos = 0
            }
        }
    }

    override fun isSpeechDetected(): Boolean = lastProbability > threshold

    override fun reset() {
        hState.fill(0f)
        cState.fill(0f)
        buffer.fill(0f)
        bufferPos = 0
        lastProbability = 0f
    }

    override fun release() {
        try {
            session.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing session: ${e.message}")
        }
    }

    /** Get the raw speech probability (for logging/debugging). */
    fun getProbability(): Float = lastProbability

    // ── ONNX inference ─────────────────────────────────────────────────────

    private fun runInference(windowSamples: FloatArray) {
        // Input tensors
        val inputTensor = OnnxTensor.createTensor(
            env, FloatBuffer.wrap(windowSamples), longArrayOf(1, windowSize.toLong())
        )
        val srTensor = OnnxTensor.createTensor(
            env, LongBuffer.wrap(longArrayOf(sampleRate.toLong())), longArrayOf(1)
        )
        val hTensor = OnnxTensor.createTensor(
            env, FloatBuffer.wrap(hState),
            longArrayOf(STATE_LAYERS.toLong(), 1, STATE_DIM.toLong())
        )
        val cTensor = OnnxTensor.createTensor(
            env, FloatBuffer.wrap(cState),
            longArrayOf(STATE_LAYERS.toLong(), 1, STATE_DIM.toLong())
        )

        try {
            val inputs = mapOf(
                "input" to inputTensor,
                "sr" to srTensor,
                "h" to hTensor,
                "c" to cTensor,
            )

            val result = session.run(inputs)
            try {
                // Output 0: speech probability [1, 1]
                val outputTensor = result.get(0) as OnnxTensor
                lastProbability = outputTensor.floatBuffer.get(0)

                // Output 1: updated hidden state [2, 1, 64]
                val hnTensor = result.get(1) as OnnxTensor
                val hnBuffer = hnTensor.floatBuffer
                hnBuffer.get(hState)

                // Output 2: updated cell state [2, 1, 64]
                val cnTensor = result.get(2) as OnnxTensor
                val cnBuffer = cnTensor.floatBuffer
                cnBuffer.get(cState)
            } finally {
                result.close()
            }
        } finally {
            inputTensor.close()
            srTensor.close()
            hTensor.close()
            cTensor.close()
        }
    }
}
