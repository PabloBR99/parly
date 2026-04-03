package com.linguaface.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import com.facebook.react.bridge.*
import java.nio.ByteBuffer
import java.nio.ByteOrder

class AudioModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "LinguaFaceAudio"

    @ReactMethod
    fun configureSession(promise: Promise) {
        val audioManager = reactApplicationContext
            .getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        promise.resolve(null)
    }

    @ReactMethod
    fun playPCM(base64Data: String, sampleRate: Double, promise: Promise) {
        try {
            val pcmBytes = Base64.decode(base64Data, Base64.DEFAULT)
            val sampleRateInt = sampleRate.toInt()
            val bufferSize = AudioTrack.getMinBufferSize(
                sampleRateInt,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRateInt)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()

            // Convert bytes to Int16 array
            val shorts = ShortArray(pcmBytes.size / 2)
            ByteBuffer.wrap(pcmBytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)

            track.write(shorts, 0, shorts.size)
            track.setNotificationMarkerPosition(shorts.size)
            track.setPlaybackPositionUpdateListener(object :
                AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onPeriodicNotification(track: AudioTrack) {}
                override fun onMarkerReached(track: AudioTrack) {
                    track.release()
                    promise.resolve(null)
                }
            })
            track.play()
        } catch (e: Exception) {
            promise.reject("PLAYBACK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopPlayback(promise: Promise) {
        // Simplified: no global track reference kept — handled per play call
        promise.resolve(null)
    }
}
