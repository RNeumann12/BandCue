package com.bandcue.songsterr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
