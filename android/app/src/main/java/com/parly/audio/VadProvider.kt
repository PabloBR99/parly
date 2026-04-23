package com.parly.audio

/**
 * Common interface for Voice Activity Detection implementations.
 * Replaces direct dependency on sherpa-onnx's Vad class.
 */
interface VadProvider {
    /** Feed Float32 PCM samples (mono, 16kHz). May buffer internally. */
    fun acceptWaveform(samples: FloatArray)

    /** Whether speech is currently detected (probability > threshold). */
    fun isSpeechDetected(): Boolean

    /** Reset internal state (hidden states, buffer, probability). */
    fun reset()

    /** Release all resources (ONNX session, tensors). */
    fun release()
}
