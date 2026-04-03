package com.linguaface.translation

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions

class TranslationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "LinguaFaceTranslation"

    // Reuse translator instances — creating a new one per call discards the loaded model
    private val translatorCache = mutableMapOf<String, com.google.mlkit.nl.translate.Translator>()
    // Track pairs whose models are confirmed downloaded — skip downloadModelIfNeeded overhead
    private val readyPairs = mutableSetOf<String>()

    private fun pairKey(fromLang: String, toLang: String) = "$fromLang|$toLang"

    private fun getOrCreateTranslator(fromLang: String, toLang: String): com.google.mlkit.nl.translate.Translator {
        val key = pairKey(fromLang, toLang)
        return translatorCache.getOrPut(key) {
            Translation.getClient(
                TranslatorOptions.Builder()
                    .setSourceLanguage(fromLang)
                    .setTargetLanguage(toLang)
                    .build()
            )
        }
    }

    @ReactMethod
    fun translate(text: String, from: String, to: String, promise: Promise) {
        val fromLang = bcp47ToMlKit(from)
        val toLang = bcp47ToMlKit(to)

        if (fromLang == null || toLang == null) {
            promise.reject("UNSUPPORTED_LANGUAGE", "Language pair not supported: $from -> $to")
            return
        }

        val translator = getOrCreateTranslator(fromLang, toLang)
        val key = pairKey(fromLang, toLang)

        var settled = false
        fun settle(block: () -> Unit) {
            if (!settled) { settled = true; block() }
        }

        val handler = Handler(Looper.getMainLooper())
        handler.postDelayed({
            settle { promise.reject("TRANSLATION_TIMEOUT", "Translation timed out (model download?)") }
        }, 15_000)

        fun doTranslate() {
            translator.translate(text)
                .addOnSuccessListener { result ->
                    handler.removeCallbacksAndMessages(null)
                    settle { promise.resolve(result) }
                }
                .addOnFailureListener { e ->
                    handler.removeCallbacksAndMessages(null)
                    settle { promise.reject("TRANSLATION_ERROR", e.message, e) }
                }
        }

        if (readyPairs.contains(key)) {
            // Model already confirmed on-device — translate directly, zero download overhead
            doTranslate()
        } else {
            translator.downloadModelIfNeeded(DownloadConditions.Builder().build())
                .addOnSuccessListener {
                    readyPairs.add(key)
                    doTranslate()
                }
                .addOnFailureListener { e ->
                    handler.removeCallbacksAndMessages(null)
                    settle { promise.reject("MODEL_DOWNLOAD_ERROR", e.message, e) }
                }
        }
    }

    @ReactMethod
    fun isModelDownloaded(from: String, to: String, promise: Promise) {
        val fromLang = bcp47ToMlKit(from)
        val toLang = bcp47ToMlKit(to)
        if (fromLang == null || toLang == null) { promise.resolve(false); return }
        promise.resolve(readyPairs.contains(pairKey(fromLang, toLang)))
    }

    @ReactMethod
    fun downloadModel(from: String, to: String, promise: Promise) {
        val fromLang = bcp47ToMlKit(from) ?: run { promise.resolve(null); return }
        val toLang = bcp47ToMlKit(to) ?: run { promise.resolve(null); return }

        val key = pairKey(fromLang, toLang)
        if (readyPairs.contains(key)) { promise.resolve(null); return }

        val translator = getOrCreateTranslator(fromLang, toLang)
        translator.downloadModelIfNeeded()
            .addOnSuccessListener {
                readyPairs.add(key)
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("DOWNLOAD_ERROR", e.message, e)
            }
    }

    private fun bcp47ToMlKit(code: String): String? {
        // ML Kit uses ISO 639-1 language codes — strip region tags
        val lang = code.split("-", "_").first().lowercase()
        return when (lang) {
            "af" -> TranslateLanguage.AFRIKAANS
            "ar" -> TranslateLanguage.ARABIC
            "be" -> TranslateLanguage.BELARUSIAN
            "bg" -> TranslateLanguage.BULGARIAN
            "bn" -> TranslateLanguage.BENGALI
            "ca" -> TranslateLanguage.CATALAN
            "cs" -> TranslateLanguage.CZECH
            "cy" -> TranslateLanguage.WELSH
            "da" -> TranslateLanguage.DANISH
            "de" -> TranslateLanguage.GERMAN
            "el" -> TranslateLanguage.GREEK
            "en" -> TranslateLanguage.ENGLISH
            "eo" -> TranslateLanguage.ESPERANTO
            "es" -> TranslateLanguage.SPANISH
            "et" -> TranslateLanguage.ESTONIAN
            "fi" -> TranslateLanguage.FINNISH
            "fr" -> TranslateLanguage.FRENCH
            "ga" -> TranslateLanguage.IRISH
            "gl" -> TranslateLanguage.GALICIAN
            "gu" -> TranslateLanguage.GUJARATI
            "he" -> TranslateLanguage.HEBREW
            "hi" -> TranslateLanguage.HINDI
            "hr" -> TranslateLanguage.CROATIAN
            "hu" -> TranslateLanguage.HUNGARIAN
            "id" -> TranslateLanguage.INDONESIAN
            "is" -> TranslateLanguage.ICELANDIC
            "it" -> TranslateLanguage.ITALIAN
            "ja" -> TranslateLanguage.JAPANESE
            "ka" -> TranslateLanguage.GEORGIAN
            "kn" -> TranslateLanguage.KANNADA
            "ko" -> TranslateLanguage.KOREAN
            "lt" -> TranslateLanguage.LITHUANIAN
            "lv" -> TranslateLanguage.LATVIAN
            "mk" -> TranslateLanguage.MACEDONIAN
            "mr" -> TranslateLanguage.MARATHI
            "ms" -> TranslateLanguage.MALAY
            "mt" -> TranslateLanguage.MALTESE
            "nl" -> TranslateLanguage.DUTCH
            "nb", "no" -> TranslateLanguage.NORWEGIAN
            "pl" -> TranslateLanguage.POLISH
            "pt" -> TranslateLanguage.PORTUGUESE
            "ro" -> TranslateLanguage.ROMANIAN
            "ru" -> TranslateLanguage.RUSSIAN
            "sk" -> TranslateLanguage.SLOVAK
            "sl" -> TranslateLanguage.SLOVENIAN
            "sq" -> TranslateLanguage.ALBANIAN
            "sv" -> TranslateLanguage.SWEDISH
            "sw" -> TranslateLanguage.SWAHILI
            "ta" -> TranslateLanguage.TAMIL
            "te" -> TranslateLanguage.TELUGU
            "th" -> TranslateLanguage.THAI
            "tl" -> TranslateLanguage.TAGALOG
            "tr" -> TranslateLanguage.TURKISH
            "uk" -> TranslateLanguage.UKRAINIAN
            "ur" -> TranslateLanguage.URDU
            "vi" -> TranslateLanguage.VIETNAMESE
            "zh" -> TranslateLanguage.CHINESE
            else -> null
        }
    }
}
