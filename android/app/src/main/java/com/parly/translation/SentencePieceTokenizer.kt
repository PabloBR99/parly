package com.parly.translation

import android.util.Log
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Lightweight SentencePiece tokenizer for MarianMT ONNX models.
 *
 * Reads a .spm (SentencePiece model) binary protobuf and extracts the
 * vocabulary with scores. Implements greedy unigram tokenization which
 * is sufficient for MarianMT's SentencePiece unigram models.
 *
 * The SentencePiece protobuf format:
 *   ModelProto (field 1: repeated SentencePiece pieces)
 *   SentencePiece (field 1: string piece, field 2: float score, field 3: enum type)
 *
 * Unicode: The sentencepiece "▁" (U+2581) represents a word boundary (space).
 */
class SentencePieceTokenizer(modelPath: String) : Closeable {

    companion object {
        private const val TAG = "SentencePiece"
        /** SentencePiece uses ▁ (U+2581) as the space/word-boundary marker. */
        private const val SP_SPACE = "\u2581"
    }

    /** Vocabulary: piece string → (id, score). */
    private val vocab: Map<String, Pair<Int, Float>>
    /** Reverse lookup: id → piece string. */
    private val idToPiece: Map<Int, String>

    private val unkId: Int

    init {
        val pieces = parseSpmModel(File(modelPath).readBytes())
        val vocabMap = mutableMapOf<String, Pair<Int, Float>>()
        val reverseMap = mutableMapOf<Int, String>()
        var foundUnk = 0

        for ((index, piece) in pieces.withIndex()) {
            vocabMap[piece.text] = Pair(index, piece.score)
            reverseMap[index] = piece.text
            if (piece.type == PieceType.UNKNOWN) foundUnk = index
        }

        vocab = vocabMap
        idToPiece = reverseMap
        unkId = foundUnk
        Log.i(TAG, "Loaded SPM model: ${vocab.size} pieces from $modelPath")
    }

    /**
     * Encode text into SentencePiece token strings.
     *
     * Steps:
     * 1. Prepend ▁ and replace spaces with ▁
     * 2. Greedily match longest vocab pieces (unigram-like)
     */
    fun encode(text: String): List<String> {
        if (text.isBlank()) return emptyList()

        // Normalize: prepend space marker, replace spaces
        val normalized = SP_SPACE + text.replace(" ", SP_SPACE)

        return tokenize(normalized)
    }

    /**
     * Decode a list of token strings back to text.
     * Reverses the ▁ space encoding.
     */
    fun decode(tokens: List<String>): String {
        val joined = tokens.joinToString("")
        // Remove leading space marker, convert remaining ▁ to spaces
        return joined.replace(SP_SPACE, " ").trimStart()
    }

    override fun close() {
        // No native resources to free — pure Kotlin implementation
    }

    // ── Tokenization ────────────────────────────────────────────────────────

    /**
     * Greedy longest-match tokenization.
     *
     * For each position, find the longest vocab piece that matches.
     * This is a simplification of the full Viterbi unigram algorithm,
     * but works well enough for MarianMT models in practice.
     */
    private fun tokenize(text: String): List<String> {
        val tokens = mutableListOf<String>()
        var pos = 0

        while (pos < text.length) {
            var bestLen = 0
            var bestPiece: String? = null
            var bestScore = Float.NEGATIVE_INFINITY

            // Try all substrings starting at pos, up to reasonable max length
            val maxLen = minOf(text.length - pos, 64)
            for (len in 1..maxLen) {
                val candidate = text.substring(pos, pos + len)
                val entry = vocab[candidate]
                if (entry != null) {
                    val (_, score) = entry
                    // Prefer longer matches; among same length, prefer higher score
                    if (len > bestLen || (len == bestLen && score > bestScore)) {
                        bestLen = len
                        bestPiece = candidate
                        bestScore = score
                    }
                }
            }

            if (bestPiece != null) {
                tokens.add(bestPiece)
                pos += bestLen
            } else {
                // Unknown character — encode as individual UTF-8 byte pieces or skip
                // MarianMT models typically have byte fallback pieces like <0xNN>
                val ch = text[pos]
                val byteFallback = encodeByteFallback(ch)
                if (byteFallback != null) {
                    tokens.addAll(byteFallback)
                }
                // If no byte fallback found, skip the character (rare for MarianMT)
                pos++
            }
        }

        return tokens
    }

    /** Try to encode a character as SentencePiece byte fallback tokens (<0xNN>). */
    private fun encodeByteFallback(ch: Char): List<String>? {
        val bytes = ch.toString().toByteArray(Charsets.UTF_8)
        val pieces = mutableListOf<String>()
        for (b in bytes) {
            val hex = String.format("<0x%02X>", b.toInt() and 0xFF)
            if (vocab.containsKey(hex)) {
                pieces.add(hex)
            } else {
                return null // Can't encode this byte
            }
        }
        return pieces
    }

    // ── Protobuf parsing ────────────────────────────────────────────────────

    private enum class PieceType { NORMAL, UNKNOWN, CONTROL, USER_DEFINED, BYTE_FALLBACK }

    private data class SpmPiece(val text: String, val score: Float, val type: PieceType)

    /**
     * Minimal protobuf parser for SentencePiece ModelProto.
     *
     * We only need field 1 (repeated SentencePiece), which contains:
     *   field 1: string (piece text)
     *   field 2: float (score)
     *   field 3: int32 (type enum)
     */
    private fun parseSpmModel(data: ByteArray): List<SpmPiece> {
        val pieces = mutableListOf<SpmPiece>()
        val buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)

        while (buf.hasRemaining()) {
            val tag = readVarint(buf) ?: break
            val fieldNumber = (tag shr 3).toInt()
            val wireType = (tag and 0x7).toInt()

            when {
                // Field 1 = pieces (repeated, length-delimited = wireType 2)
                fieldNumber == 1 && wireType == 2 -> {
                    val len = readVarint(buf)?.toInt() ?: break
                    if (len <= 0 || buf.remaining() < len) break
                    val pieceData = ByteArray(len)
                    buf.get(pieceData)
                    pieces.add(parsePiece(pieceData))
                }
                // Skip other fields
                wireType == 0 -> readVarint(buf) // varint
                wireType == 1 -> if (buf.remaining() >= 8) buf.position(buf.position() + 8) // 64-bit
                wireType == 2 -> {
                    val len = readVarint(buf)?.toInt() ?: break
                    if (len > 0 && buf.remaining() >= len) buf.position(buf.position() + len)
                }
                wireType == 5 -> if (buf.remaining() >= 4) buf.position(buf.position() + 4) // 32-bit
                else -> break
            }
        }

        return pieces
    }

    private fun parsePiece(data: ByteArray): SpmPiece {
        var text = ""
        var score = 0f
        var type = PieceType.NORMAL

        val buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        while (buf.hasRemaining()) {
            val tag = readVarint(buf) ?: break
            val fieldNumber = (tag shr 3).toInt()
            val wireType = (tag and 0x7).toInt()

            when {
                fieldNumber == 1 && wireType == 2 -> {
                    val len = readVarint(buf)?.toInt() ?: break
                    if (len > 0 && buf.remaining() >= len) {
                        val strBytes = ByteArray(len)
                        buf.get(strBytes)
                        text = String(strBytes, Charsets.UTF_8)
                    }
                }
                fieldNumber == 2 && wireType == 5 -> {
                    if (buf.remaining() >= 4) score = buf.float
                }
                fieldNumber == 3 && wireType == 0 -> {
                    val t = readVarint(buf)?.toInt() ?: 0
                    type = when (t) {
                        1 -> PieceType.UNKNOWN
                        2 -> PieceType.CONTROL
                        3 -> PieceType.USER_DEFINED
                        4 -> PieceType.BYTE_FALLBACK
                        6 -> PieceType.BYTE_FALLBACK
                        else -> PieceType.NORMAL
                    }
                }
                wireType == 0 -> readVarint(buf)
                wireType == 1 -> if (buf.remaining() >= 8) buf.position(buf.position() + 8)
                wireType == 2 -> {
                    val len = readVarint(buf)?.toInt() ?: break
                    if (len > 0 && buf.remaining() >= len) buf.position(buf.position() + len)
                }
                wireType == 5 -> if (buf.remaining() >= 4) buf.position(buf.position() + 4)
                else -> break
            }
        }

        return SpmPiece(text, score, type)
    }

    private fun readVarint(buf: ByteBuffer): Long? {
        var result = 0L
        var shift = 0
        while (buf.hasRemaining()) {
            val b = buf.get().toLong() and 0xFF
            result = result or ((b and 0x7F) shl shift)
            if (b and 0x80 == 0L) return result
            shift += 7
            if (shift >= 64) return null
        }
        return null
    }
}
