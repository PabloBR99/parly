package com.parly.audio

import android.app.ActivityManager
import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MemoryModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ParlyMemory"

    @ReactMethod
    fun getAvailableMemoryMB(promise: Promise) {
        try {
            val am = reactApplicationContext
                .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            promise.resolve((info.availMem / (1024 * 1024)).toInt())
        } catch (e: Exception) {
            promise.reject("MEMORY_ERROR", e.message, e)
        }
    }
}
