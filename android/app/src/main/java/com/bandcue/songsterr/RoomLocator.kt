package com.bandcue.songsterr

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.CompletionService
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

const val DEFAULT_ROOM_PORT = 4173
val DISCOVERY_LOCAL_HOSTS = listOf("10.0.2.2", "127.0.0.1", "localhost")
const val MDNS_HOST_STEM = "bandcue"
const val DISCOVERY_REQUEST_TYPE = "bandcue.discovery.request"
const val DISCOVERY_RESPONSE_TYPE = "bandcue.discovery.response"
const val DISCOVERY_PROTOCOL_VERSION = 1
// Keep in sync with DEFAULT_LAN_SCAN_SUBNETS in src/shared/room-locator.ts
// (the canonical list) and LAN_SCAN_SUBNETS in extension/songsterr/background.js.
val LAN_SCAN_SUBNETS = listOf(
    "192.168.0",
    "192.168.1",
    "192.168.178",
    "192.168.2",
    "192.168.4",
    "192.168.86",
    "10.0.0",
    "10.0.1",
    "10.0.2",
    "172.16.0",
    "172.20.10"
)

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

data class BandCueDiscoveryResponse(
    val roomCode: String,
    val port: Int,
    val host: String
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
        return localCandidates(value.toInt())
    }

    if (isRoomCode(value)) {
        val roomCode = value.uppercase(Locale.US)
        return localCandidates(defaultPort, roomCode)
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

fun buildLanScanCandidates(locator: String, defaultPort: Int = DEFAULT_ROOM_PORT): List<RoomDiscoveryCandidate> {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (!isPort(value) && !isRoomCode(value)) {
        return emptyList()
    }

    val expectedRoomCode = if (isRoomCode(value)) value.uppercase(Locale.US) else null
    val port = if (isPort(value)) value.toInt() else defaultPort
    return lanScanCandidates(port, expectedRoomCode)
}

fun mdnsRoomHosts(roomCode: String? = null): List<String> {
    val hosts = mutableListOf("$MDNS_HOST_STEM.local")
    if (roomCode != null && isRoomCode(roomCode)) {
        hosts.add(0, "$MDNS_HOST_STEM-${roomCode.lowercase(Locale.US)}.local")
    }
    return hosts
}

fun buildMdnsDiscoveryCandidates(locator: String, defaultPort: Int = DEFAULT_ROOM_PORT): List<RoomDiscoveryCandidate> {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (!isPort(value) && !isRoomCode(value)) {
        return emptyList()
    }

    val expectedRoomCode = if (isRoomCode(value)) value.uppercase(Locale.US) else null
    val port = if (isPort(value)) value.toInt() else defaultPort
    val roomCode = if (isRoomCode(value)) value else null
    return mdnsRoomHosts(roomCode).map { host -> roomDiscoveryCandidate(host, port, expectedRoomCode) }
}

fun buildKnownHostCandidates(
    locator: String,
    knownHosts: Collection<String>,
    defaultPort: Int = DEFAULT_ROOM_PORT
): List<RoomDiscoveryCandidate> {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (!isPort(value) && !isRoomCode(value)) {
        return emptyList()
    }

    val expectedRoomCode = if (isRoomCode(value)) value.uppercase(Locale.US) else null
    val port = if (isPort(value)) value.toInt() else defaultPort
    return knownHosts
        .mapNotNull { normalizeKnownHost(it) }
        .distinct()
        .map { host -> roomDiscoveryCandidate(host, port, expectedRoomCode) }
}

fun resolveRoomEndpoint(
    locator: String,
    defaultPort: Int = DEFAULT_ROOM_PORT,
    knownHosts: Collection<String> = emptyList()
): RoomEndpoint {
    val normalized = normalizeRoomLocator(locator, defaultPort)
    if (isAbsoluteRoomUrl(normalized)) {
        return RoomEndpoint(normalized, roomUrlToWebSocket(normalized))
    }

    val candidates = buildRoomDiscoveryCandidates(normalized, defaultPort)
    if (candidates.isEmpty()) {
        throw IllegalArgumentException("Use a room URL, room code, port, or host:port.")
    }

    val endpoint = resolveCandidates(
        uniqueCandidates(buildKnownHostCandidates(normalized, knownHosts, defaultPort) + candidates),
        timeoutMs = DIRECT_PROBE_TIMEOUT_MS
    ) ?: resolveUdpDiscovery(normalized, defaultPort)?.let { udpResponse ->
        resolveCandidates(
            listOf(roomDiscoveryCandidate(udpResponse.host, udpResponse.port, expectedRoomCodeForLocator(normalized))),
            timeoutMs = DIRECT_PROBE_TIMEOUT_MS
        )
    } ?: resolveCandidates(
        buildMdnsDiscoveryCandidates(normalized, defaultPort),
        timeoutMs = MDNS_PROBE_TIMEOUT_MS
    ) ?: resolveCandidates(
        buildLanScanCandidates(normalized, defaultPort),
        timeoutMs = LAN_SCAN_FAST_TIMEOUT_MS
    ) ?: resolveCandidates(
        buildKnownHostCandidates(normalized, knownHosts, defaultPort) + buildMdnsDiscoveryCandidates(normalized, defaultPort),
        timeoutMs = WEAK_SIGNAL_PROBE_TIMEOUT_MS
    ) ?: resolveCandidates(
        buildWeakSignalLanScanCandidates(normalized, defaultPort),
        timeoutMs = LAN_SCAN_WEAK_SIGNAL_TIMEOUT_MS
    )
    if (endpoint != null) {
        return endpoint
    }

    throw IllegalStateException(roomDiscoveryFailureMessage(normalized, defaultPort))
}

fun roomDiscoveryFailureMessage(locator: String, defaultPort: Int = DEFAULT_ROOM_PORT): String {
    val normalized = normalizeRoomLocator(locator, defaultPort)
    if (isPort(normalized) || isRoomCode(normalized)) {
        val port = if (isPort(normalized)) normalized.toInt() else defaultPort
        return "No BandCue room found for \"$normalized\". Tried local hosts ${DISCOVERY_LOCAL_HOSTS.joinToString(", ")} and scanned ${formatLanScanSubnets()} on port $port. ${manualDiscoveryFallback(port)}"
    }

    val explicitHost = parseHostAndPort(normalized, defaultPort)
    if (explicitHost != null) {
        return "No BandCue room found for \"$normalized\". Tried ${explicitHost.first}:${explicitHost.second}. ${manualDiscoveryFallback(explicitHost.second)}"
    }

    return "No BandCue room found for \"$normalized\". Use a room URL, room code, port, or host:port."
}

fun formatLanScanSubnets(): String = LAN_SCAN_SUBNETS.joinToString(", ") { "$it.1-254" }

fun manualDiscoveryFallback(port: Int): String =
    "If discovery is blocked by Wi-Fi isolation, firewall, VPN, or a different subnet, enter the host:port shown on the host page, such as 192.168.1.12:$port, or paste the full room URL."

fun expectedRoomCodeForLocator(locator: String): String? {
    val value = normalizeRoomLocator(locator)
    return if (isRoomCode(value)) value.uppercase(Locale.US) else null
}

private fun resolveCandidates(
    candidates: List<RoomDiscoveryCandidate>,
    timeoutMs: Int
): RoomEndpoint? {
    if (candidates.isEmpty()) {
        return null
    }

    val pool = Executors.newFixedThreadPool(32)
    val completion: CompletionService<RoomEndpoint?> = ExecutorCompletionService(pool)

    try {
        var submitted = 0
        for (candidate in candidates) {
            completion.submit(Callable { tryResolveRoomCandidate(candidate, timeoutMs) })
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

private fun tryResolveRoomCandidate(candidate: RoomDiscoveryCandidate, timeoutMs: Int): RoomEndpoint? {
    return try {
        val connection = URL(candidate.apiUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
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

private fun resolveUdpDiscovery(locator: String, defaultPort: Int): BandCueDiscoveryResponse? {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (!isPort(value) && !isRoomCode(value)) {
        return null
    }

    val discoveryPort = if (isPort(value)) value.toInt() else defaultPort
    val expectedRoomCode = expectedRoomCodeForLocator(value)
    return discoverBandCueRooms(expectedRoomCode, discoveryPort).firstOrNull()
}

fun discoverBandCueRooms(
    roomCode: String? = null,
    discoveryPort: Int = DEFAULT_ROOM_PORT,
    timeoutMs: Int = UDP_DISCOVERY_TIMEOUT_MS
): List<BandCueDiscoveryResponse> {
    val request = JSONObject()
        .put("type", DISCOVERY_REQUEST_TYPE)
        .put("protocol", DISCOVERY_PROTOCOL_VERSION)
    if (!roomCode.isNullOrBlank()) {
        request.put("roomCode", roomCode.uppercase(Locale.US))
    }

    val payload = request.toString().toByteArray(Charsets.UTF_8)
    val responses = linkedMapOf<String, BandCueDiscoveryResponse>()
    return try {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = timeoutMs
            for (host in broadcastHosts()) {
                val address = InetAddress.getByName(host)
                socket.send(DatagramPacket(payload, payload.size, address, discoveryPort))
            }

            val buffer = ByteArray(2048)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (_: Exception) {
                    break
                }
                val raw = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
                val parsed = parseDiscoveryResponse(raw, packet.address.hostAddress ?: continue) ?: continue
                if (roomCode != null && !parsed.roomCode.equals(roomCode, ignoreCase = true)) {
                    continue
                }
                responses["${parsed.host}:${parsed.roomCode}:${parsed.port}"] = parsed
            }
        }
        responses.values.toList()
    } catch (_: Exception) {
        emptyList()
    }
}

fun parseDiscoveryResponse(raw: String, host: String): BandCueDiscoveryResponse? {
    return try {
        val parsed = JSONObject(raw)
        val port = parsed.optInt("port", -1)
        if (
            parsed.optString("type") != DISCOVERY_RESPONSE_TYPE ||
            parsed.optInt("protocol") != DISCOVERY_PROTOCOL_VERSION ||
            parsed.optString("roomCode").isBlank() ||
            port !in 1..65535
        ) {
            return null
        }

        BandCueDiscoveryResponse(
            roomCode = parsed.optString("roomCode").uppercase(Locale.US),
            port = port,
            host = host
        )
    } catch (_: Exception) {
        null
    }
}

private fun localCandidates(port: Int, expectedRoomCode: String? = null): List<RoomDiscoveryCandidate> =
    DISCOVERY_LOCAL_HOSTS.map { host -> roomDiscoveryCandidate(host, port, expectedRoomCode) }

private fun lanScanCandidates(port: Int, expectedRoomCode: String? = null): List<RoomDiscoveryCandidate> {
    return prioritizeScanSubnets(localScanSubnets()).flatMap { subnet ->
        (1..254).map { host -> roomDiscoveryCandidate("$subnet.$host", port, expectedRoomCode) }
    }
}

private fun buildWeakSignalLanScanCandidates(
    locator: String,
    defaultPort: Int,
    subnetLimit: Int = WEAK_SIGNAL_SUBNET_LIMIT
): List<RoomDiscoveryCandidate> {
    val value = normalizeRoomLocator(locator, defaultPort)
    if (!isPort(value) && !isRoomCode(value)) {
        return emptyList()
    }

    val expectedRoomCode = if (isRoomCode(value)) value.uppercase(Locale.US) else null
    val port = if (isPort(value)) value.toInt() else defaultPort
    return prioritizeScanSubnets(localScanSubnets())
        .take(subnetLimit)
        .flatMap { subnet -> (1..254).map { host -> roomDiscoveryCandidate("$subnet.$host", port, expectedRoomCode) } }
}

// Extracts the /24 subnet prefix ("a.b.c") from a private-LAN IPv4 address, or
// null for public, loopback, link-local, or non-IPv4 input. Keep in sync with
// lanSubnetPrefix in src/shared/room-locator.ts.
fun lanSubnetPrefix(address: String?): String? {
    val match = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
        .matchEntire(address?.trim().orEmpty()) ?: return null
    val octets = match.groupValues.drop(1).map { it.toInt() }
    if (octets.any { it > 255 }) return null
    val (a, b) = octets
    val isPrivate = a == 10 || (a == 192 && b == 168) || (a == 172 && b in 16..31)
    return if (isPrivate) "${octets[0]}.${octets[1]}.${octets[2]}" else null
}

// Reads this device's own LAN subnets so discovery scans the local network
// first instead of brute-forcing every documented default.
fun localScanSubnets(): List<String> {
    return try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
            .flatMap { Collections.list(it.inetAddresses) }
            .mapNotNull { lanSubnetPrefix(it.hostAddress) }
            .distinct()
    } catch (_: Exception) {
        emptyList()
    }
}

// Returns the scan subnet list with this device's own subnets first (deduped),
// then the documented defaults. Keep in sync with prioritizeScanSubnets in
// src/shared/room-locator.ts.
fun prioritizeScanSubnets(
    localSubnets: List<String>,
    subnets: List<String> = LAN_SCAN_SUBNETS
): List<String> {
    val ordered = LinkedHashSet<String>()
    ordered.addAll(localSubnets)
    ordered.addAll(subnets)
    return ordered.toList()
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

private fun uniqueCandidates(candidates: List<RoomDiscoveryCandidate>): List<RoomDiscoveryCandidate> {
    val seen = linkedSetOf<String>()
    return candidates.filter { seen.add(it.apiUrl) }
}

private fun normalizeKnownHost(host: String?): String? {
    val trimmed = host?.trim().orEmpty()
    if (trimmed.isBlank() || trimmed == "localhost" || trimmed == "127.0.0.1") {
        return null
    }
    return try {
        URL("http://$trimmed").host.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }
}

private fun broadcastHosts(): List<String> {
    val hosts = linkedSetOf("255.255.255.255")
    try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
            .flatMap { iface ->
                iface.interfaceAddresses
                    .mapNotNull { address -> broadcastAddress(address.address?.hostAddress, address.networkPrefixLength) }
            }
            .forEach { hosts.add(it) }
    } catch (_: Exception) {
        // The global broadcast address above is still worth trying.
    }
    return hosts.toList()
}

private fun broadcastAddress(address: String?, prefixLength: Short): String? {
    val match = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
        .matchEntire(address?.trim().orEmpty()) ?: return null
    if (prefixLength !in 0..32) {
        return null
    }
    val octets = match.groupValues.drop(1).map { it.toInt() }
    if (octets.any { it > 255 }) {
        return null
    }

    val value = octets.fold(0) { result, part -> (result shl 8) or part }
    val mask = if (prefixLength.toInt() == 0) 0 else (-1 shl (32 - prefixLength.toInt()))
    val broadcast = value or mask.inv()
    return listOf(
        (broadcast ushr 24) and 255,
        (broadcast ushr 16) and 255,
        (broadcast ushr 8) and 255,
        broadcast and 255
    ).joinToString(".")
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

private const val DIRECT_PROBE_TIMEOUT_MS = 1000
private const val MDNS_PROBE_TIMEOUT_MS = 1500
private const val WEAK_SIGNAL_PROBE_TIMEOUT_MS = 3000
private const val LAN_SCAN_FAST_TIMEOUT_MS = 450
private const val LAN_SCAN_WEAK_SIGNAL_TIMEOUT_MS = 900
private const val UDP_DISCOVERY_TIMEOUT_MS = 900
private const val WEAK_SIGNAL_SUBNET_LIMIT = 6
