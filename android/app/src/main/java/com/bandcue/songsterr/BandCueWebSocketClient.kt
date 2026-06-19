package com.bandcue.songsterr

import android.util.Base64
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.net.ssl.SSLSocketFactory
import kotlin.experimental.xor

class BandCueWebSocketClient(
    private val wsUrl: String,
    private val listener: Listener
) {
    interface Listener {
        fun onOpen()
        fun onText(message: String)
        fun onClosed(reason: String)
        fun onError(error: Throwable)
    }

    private val random = SecureRandom()
    private var socket: Socket? = null
    private var input: BufferedInputStream? = null
    private var output: BufferedOutputStream? = null
    @Volatile private var closed = false

    fun connect() {
        try {
            val url = URL(wsUrl.replaceFirst("ws://", "http://").replaceFirst("wss://", "https://"))
            val secure = wsUrl.startsWith("wss://", ignoreCase = true)
            val port = when {
                url.port >= 0 -> url.port
                secure -> 443
                else -> 80
            }
            val rawSocket = if (secure) {
                SSLSocketFactory.getDefault().createSocket() as Socket
            } else {
                Socket()
            }
            rawSocket.connect(InetSocketAddress(url.host, port), 5000)
            socket = rawSocket
            input = BufferedInputStream(rawSocket.getInputStream())
            output = BufferedOutputStream(rawSocket.getOutputStream())

            performHandshake(url, port)
            listener.onOpen()
            readLoop()
        } catch (error: Throwable) {
            if (!closed) {
                listener.onError(error)
            }
            close()
        }
    }

    @Synchronized
    fun sendText(message: String) {
        if (closed) {
            return
        }
        writeFrame(opcode = 0x1, payload = message.toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun close() {
        if (closed) {
            return
        }

        closed = true
        try {
            writeFrame(opcode = 0x8, payload = ByteArray(0))
        } catch (_: Exception) {
            // Socket teardown below is enough when the close frame cannot be sent.
        }
        try {
            socket?.close()
        } catch (_: Exception) {
            // Already closing.
        }
    }

    private fun performHandshake(url: URL, port: Int) {
        val keyBytes = ByteArray(16)
        random.nextBytes(keyBytes)
        val key = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
        val path = buildString {
            append(if (url.path.isNullOrBlank()) "/" else url.path)
            if (!url.query.isNullOrBlank()) {
                append("?").append(url.query)
            }
        }
        val host = if ((url.protocol == "http" && port == 80) || (url.protocol == "https" && port == 443)) {
            url.host
        } else {
            "${url.host}:$port"
        }
        val request = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(host).append("\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }

        val out = output ?: error("WebSocket output is unavailable")
        out.write(request.toByteArray(Charsets.US_ASCII))
        out.flush()

        val headers = readHttpHeaders()
        if (!headers.startsWith("HTTP/1.1 101") && !headers.startsWith("HTTP/1.0 101")) {
            throw IllegalStateException("WebSocket upgrade failed: ${headers.lineSequence().firstOrNull().orEmpty()}")
        }

        val accept = headers
            .lineSequence()
            .firstOrNull { it.startsWith("Sec-WebSocket-Accept:", ignoreCase = true) }
            ?.substringAfter(":")
            ?.trim()
        val expected = expectedAccept(key)
        if (accept != null && accept != expected) {
            throw IllegalStateException("WebSocket upgrade returned an invalid accept key")
        }
    }

    private fun readHttpHeaders(): String {
        val input = input ?: error("WebSocket input is unavailable")
        val buffer = StringBuilder()
        var matched = 0
        val marker = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        while (true) {
            val value = input.read()
            if (value < 0) {
                throw IllegalStateException("WebSocket upgrade ended before headers completed")
            }

            val byte = value.toByte()
            buffer.append(byte.toInt().toChar())
            matched = if (byte == marker[matched]) matched + 1 else if (byte == marker[0]) 1 else 0
            if (matched == marker.size) {
                return buffer.toString()
            }

            if (buffer.length > 16_384) {
                throw IllegalStateException("WebSocket upgrade headers were too large")
            }
        }
    }

    private fun readLoop() {
        val input = input ?: return
        while (!closed) {
            val first = input.read()
            if (first < 0) {
                listener.onClosed("Socket closed")
                close()
                return
            }

            val second = readRequiredByte(input)
            val opcode = first and 0x0f
            val masked = second and 0x80 != 0
            var length = (second and 0x7f).toLong()
            if (length == 126L) {
                length = readUnsignedShort(input).toLong()
            } else if (length == 127L) {
                length = readLong(input)
            }

            val mask = if (masked) ByteArray(4).also { readFully(input, it) } else null
            if (length > 1_000_000) {
                throw IllegalStateException("WebSocket frame too large")
            }

            val payload = ByteArray(length.toInt())
            readFully(input, payload)
            if (mask != null) {
                for (index in payload.indices) {
                    payload[index] = payload[index] xor mask[index % 4]
                }
            }

            when (opcode) {
                0x1 -> listener.onText(payload.toString(Charsets.UTF_8))
                0x8 -> {
                    listener.onClosed("Server closed the WebSocket")
                    close()
                    return
                }
                0x9 -> writeFrame(opcode = 0xA, payload = payload)
                0xA -> Unit
                else -> Unit
            }
        }
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val out = output ?: return
        val mask = ByteArray(4)
        random.nextBytes(mask)
        out.write(0x80 or opcode)
        when {
            payload.size < 126 -> out.write(0x80 or payload.size)
            payload.size <= 0xffff -> {
                out.write(0x80 or 126)
                out.write((payload.size shr 8) and 0xff)
                out.write(payload.size and 0xff)
            }
            else -> {
                out.write(0x80 or 127)
                repeat(8) { shift ->
                    out.write(((payload.size.toLong() shr (56 - shift * 8)) and 0xff).toInt())
                }
            }
        }
        out.write(mask)
        for (index in payload.indices) {
            out.write((payload[index] xor mask[index % 4]).toInt())
        }
        out.flush()
    }

    private fun expectedAccept(key: String): String {
        val digest = MessageDigest.getInstance("SHA-1")
            .digest("$key$WEBSOCKET_GUID".toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    private fun readRequiredByte(input: BufferedInputStream): Int {
        val value = input.read()
        if (value < 0) {
            throw IllegalStateException("Unexpected end of WebSocket frame")
        }
        return value
    }

    private fun readUnsignedShort(input: BufferedInputStream): Int =
        (readRequiredByte(input) shl 8) or readRequiredByte(input)

    private fun readLong(input: BufferedInputStream): Long {
        var value = 0L
        repeat(8) {
            value = (value shl 8) or readRequiredByte(input).toLong()
        }
        return value
    }

    private fun readFully(input: BufferedInputStream, target: ByteArray) {
        var offset = 0
        while (offset < target.size) {
            val read = input.read(target, offset, target.size - offset)
            if (read < 0) {
                throw IllegalStateException("Unexpected end of WebSocket payload")
            }
            offset += read
        }
    }

    private companion object {
        const val WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    }
}
