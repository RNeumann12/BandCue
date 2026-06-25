package com.bandcue.songsterr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomLocatorTest {
    @Test
    fun detectsSupportedLocators() {
        assertTrue(isAbsoluteRoomUrl("http://192.168.1.12:4173/?token=abc"))
        assertTrue(isPort("4173"))
        assertTrue(isRoomCode("A1B2C3"))
        assertFalse(isRoomCode("host:4173"))
    }

    @Test
    fun convertsRoomUrlToWebSocketUrl() {
        assertEquals(
            "ws://192.168.1.12:4173/ws?token=abc",
            roomUrlToWebSocket("http://192.168.1.12:4173/?token=abc")
        )
    }

    @Test
    fun extractsRoomUrlFromDiscoveryState() {
        val candidate = roomDiscoveryCandidate("192.168.1.12", 4173, "A1B2C3")
        val state = JSONObject()
            .put("type", "roomState")
            .put("roomCode", "A1B2C3")
            .put("companionUrl", "http://10.0.0.2:4173/?token=secret")

        assertEquals(
            "http://192.168.1.12:4173/?token=secret",
            roomUrlFromDiscovery(state, candidate)
        )
    }

    @Test
    fun buildsExplicitHostCandidate() {
        val candidates = buildRoomDiscoveryCandidates("192.168.1.12:5000")

        assertEquals(1, candidates.size)
        assertEquals("http://192.168.1.12:5000/api/room", candidates.first().apiUrl)
    }

    @Test
    fun buildsDocumentedLanScanCandidates() {
        val candidates = buildRoomDiscoveryCandidates("A1B2C3", 5000)

        assertEquals(
            listOf(
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
            ),
            LAN_SCAN_SUBNETS
        )
        assertTrue(candidates.any { it.apiUrl == "http://192.168.1.1:5000/api/room" })
        assertTrue(candidates.any { it.apiUrl == "http://172.20.10.254:5000/api/room" })
        assertTrue(candidates.all { it.expectedRoomCode == "A1B2C3" })
        assertTrue(formatLanScanSubnets().contains("192.168.86.1-254"))
    }

    @Test
    fun derivesSubnetPrefixOnlyFromPrivateLanAddresses() {
        assertEquals("192.168.178", lanSubnetPrefix("192.168.178.47"))
        assertEquals("10.0.5", lanSubnetPrefix("10.0.5.9"))
        assertEquals("172.16.4", lanSubnetPrefix("172.16.4.2"))
        assertNull(lanSubnetPrefix("172.32.0.1"))
        assertNull(lanSubnetPrefix("8.8.8.8"))
        assertNull(lanSubnetPrefix("169.254.1.1"))
        assertNull(lanSubnetPrefix("192.168.0.300"))
        assertNull(lanSubnetPrefix(null))
    }

    @Test
    fun scansLocalSubnetsFirstThenDedupedDefaults() {
        val prioritized = prioritizeScanSubnets(listOf("192.168.178", "192.168.0"))

        assertEquals(listOf("192.168.178", "192.168.0"), prioritized.take(2))
        assertEquals(1, prioritized.count { it == "192.168.0" })
        assertTrue(prioritized.contains("172.20.10"))
        assertEquals(LAN_SCAN_SUBNETS, prioritizeScanSubnets(emptyList()))
    }

    @Test
    fun discoveryFailureMessageNamesTriedRangesAndFallback() {
        val message = roomDiscoveryFailureMessage("A1B2C3", 5000)

        assertTrue(message.contains("Tried local hosts 10.0.2.2, 127.0.0.1, localhost"))
        assertTrue(message.contains("scanned 192.168.0.1-254"))
        assertTrue(message.contains("host:port shown on the host page"))
        assertTrue(message.contains("192.168.1.12:5000"))
    }
}
