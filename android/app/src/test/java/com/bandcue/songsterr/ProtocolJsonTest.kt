package com.bandcue.songsterr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class ProtocolJsonTest {
    @Test
    fun emitsSongsterrDesktopAdapterHello() {
        val hello = JSONObject(ProtocolJson.clientHello("Pixel Songsterr"))

        assertEquals("clientHello", hello.getString("type"))
        assertEquals("Pixel Songsterr", hello.getString("deviceName"))
        assertEquals("desktop-adapter", hello.getString("role"))
        val capability = hello.getJSONArray("capabilities").getJSONObject(0)
        assertEquals("songsterr", capability.getString("app"))
        assertEquals(true, capability.getBoolean("canPlay"))
        assertEquals(true, capability.getBoolean("canStop"))
    }

    @Test
    fun parsesTransportCommandWithCurrentSong() {
        val payload = JSONObject()
            .put("type", "transportCommand")
            .put("action", "play")
            .put("sequenceId", 3)
            .put("scheduledServerTime", 12_000)
            .put("manualOffsetMs", -50)
            .put(
                "currentSong",
                JSONObject().put(
                    "song",
                    JSONObject()
                        .put("title", "Song")
                        .put("sourceType", "songsterr")
                        .put("source", "https://www.songsterr.com/a/wsa/example-tab-s1")
                )
            )

        val command = ProtocolJson.parseTransportCommand(payload)

        assertNotNull(command)
        assertEquals("play", command?.action)
        assertEquals(3, command?.sequenceId)
        assertEquals(-50L, command?.manualOffsetMs)
        assertEquals("songsterr", command?.currentSong?.sourceType)
    }
}
