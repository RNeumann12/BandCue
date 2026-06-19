package com.bandcue.songsterr

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.CompletionService
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

const val DEFAULT_ROOM_PORT = 4173

data class RoomDiscoveryCandidate(
    val apiUrl: String,
    val baseUrl: String,
    val expectedRoomCode: String? = null,
    val label: String
)

data class RoomEndpoint(
    val roomUrl: String,
    val wsUrl: String
)

fun normalizeRoomLocator(value: String?, defaultPort: Int = DEFAULT_ROOM_PORT): String {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { defaultPort.toString() }
}

fun isAbsoluteRoomUrl(value: String): Boolean = Regex("^https?://", RegexOption.IGNORE_CASE)
    .containsMatchIn(value.trim())

fun isPort(value: String): Boolean {
    val parsed = value.toIntOrNull()
    return Regex("^\\d{2,5}$").matches(value) && parsed != null && parsed in 1..65535
}

fun isRoomCode(value: String): Boolean = Regex("^[a-f0-9]{6}$", RegexOption.IGNORE_CASE)
    .matches(value)

fun roomUrlToWebSocket(room: String): String {
    val url = URL(room)
    val protocol = if (url.protocol.equals("https", ignoreCase = true)) "wss" else "ws"
    val port = if (url.port >= 0) ":${url.port}" else ""
    val token = if (url.query.isNullOrBlank()) "" else "?${url.query}"
    return "$protocol://${url.host}$port/ws$token"
}

fun buildRoomDiscoveryCandidates(
    locator: String,
    defaultPort: Int = DEFAULT_ROOM_PORT
): List<RoomDiscoveryCandidate> {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (isAbsoluteRoomUrl(value)) {
        return emptyList()
    }

    if (isPort(value)) {
        val port = value.toInt()
        return localCandidates(port) + lanScanCandidates(port = port)
    }

    if (isRoomCode(value)) {
        val roomCode = value.uppercase(Locale.US)
        return localCandidates(defaultPort, roomCode) + lanScanCandidates(defaultPort, roomCode)
    }

    val explicitHost = parseHostAndPort(value, defaultPort)
    return if (explicitHost != null) {
        listOf(roomDiscoveryCandidate(explicitHost.first, explicitHost.second))
    } else {
        emptyList()
    }
}

fun roomUrlFromDiscovery(state: JSONObject, candidate: RoomDiscoveryCandidate): String? {
    if (state.optString("type") != "roomState") {
        return null
    }

    val companionUrl = state.optString("companionUrl")
    if (companionUrl.isBlank()) {
        return null
    }

    val expectedRoomCode = candidate.expectedRoomCode
    if (
        expectedRoomCode != null &&
        !state.optString("roomCode").equals(expectedRoomCode, ignoreCase = true)
    ) {
        return null
    }

    return try {
        val discovered = URL(companionUrl)
        val token = discovered.query
            ?.split("&")
            ?.firstOrNull { it.startsWith("token=") }
            ?: return null
        "${candidate.baseUrl}/?$token"
    } catch (_: Exception) {
        null
    }
}

fun resolveRoomEndpoint(locator: String, defaultPort: Int = DEFAULT_ROOM_PORT): RoomEndpoint {
    val normalized = normalizeRoomLocator(locator, defaultPort)
    if (isAbsoluteRoomUrl(normalized)) {
        return RoomEndpoint(normalized, roomUrlToWebSocket(normalized))
    }

    val candidates = buildRoomDiscoveryCandidates(normalized, defaultPort)
    if (candidates.isEmpty()) {
        throw IllegalArgumentException("Use a room URL, room code, port, or host:port.")
    }

    val endpoint = resolveCandidates(candidates)
    if (endpoint != null) {
        return endpoint
    }

    throw IllegalStateException("No BandCue room found for \"$normalized\".")
}

private fun resolveCandidates(candidates: List<RoomDiscoveryCandidate>): RoomEndpoint? {
    val pool = Executors.newFixedThreadPool(32)
    val completion: CompletionService<RoomEndpoint?> = ExecutorCompletionService(pool)

    try {
        var submitted = 0
        for (candidate in candidates) {
            completion.submit(Callable { tryResolveRoomCandidate(candidate) })
            submitted += 1
        }

        repeat(submitted) {
            val future = completion.poll(12, TimeUnit.SECONDS) ?: return@repeat
            val endpoint = future.get()
            if (endpoint != null) {
                return endpoint
            }
        }
    } finally {
        pool.shutdownNow()
    }

    return null
}

private fun tryResolveRoomCandidate(candidate: RoomDiscoveryCandidate): RoomEndpoint? {
    return try {
        val connection = URL(candidate.apiUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 450
        connection.readTimeout = 450
        connection.requestMethod = "GET"
        connection.useCaches = false
        if (connection.responseCode != 200) {
            connection.disconnect()
            return null
        }

        val body = connection.inputStream.bufferedReader().use { it.readText() }
        connection.disconnect()
        val roomUrl = roomUrlFromDiscovery(JSONObject(body), candidate) ?: return null
        RoomEndpoint(roomUrl, roomUrlToWebSocket(roomUrl))
    } catch (_: Exception) {
        null
    }
}

private fun localCandidates(port: Int, expectedRoomCode: String? = null): List<RoomDiscoveryCandidate> =
    listOf(
        roomDiscoveryCandidate("10.0.2.2", port, expectedRoomCode),
        roomDiscoveryCandidate("127.0.0.1", port, expectedRoomCode),
        roomDiscoveryCandidate("localhost", port, expectedRoomCode)
    )

private fun lanScanCandidates(port: Int, expectedRoomCode: String? = null): List<RoomDiscoveryCandidate> {
    val subnets = listOf("192.168.0", "192.168.1", "192.168.178", "10.0.0", "10.0.1", "172.16.0")
    return subnets.flatMap { subnet ->
        (1..254).map { host -> roomDiscoveryCandidate("$subnet.$host", port, expectedRoomCode) }
    }
}

fun roomDiscoveryCandidate(
    host: String,
    port: Int,
    expectedRoomCode: String? = null
): RoomDiscoveryCandidate {
    val baseUrl = "http://$host:$port"
    return RoomDiscoveryCandidate(
        apiUrl = "$baseUrl/api/room",
        baseUrl = baseUrl,
        expectedRoomCode = expectedRoomCode,
        label = if (expectedRoomCode != null) "$expectedRoomCode on $host:$port" else "$host:$port"
    )
}

private fun parseHostAndPort(value: String, defaultPort: Int): Pair<String, Int>? {
    return try {
        val url = URL("http://$value")
        val host = url.host.takeIf { it.isNotBlank() } ?: return null
        val port = if (url.port >= 0) url.port else defaultPort
        if (port !in 1..65535) {
            null
        } else {
            host to port
        }
    } catch (_: Exception) {
        null
    }
}
