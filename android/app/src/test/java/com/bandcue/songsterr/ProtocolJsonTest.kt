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
            .put("resetBeforePlay", true)
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
        assertEquals(true, command?.resetBeforePlay)
        assertEquals("songsterr", command?.currentSong?.sourceType)
    }

    @Test
    fun parsesOpenSongCommandWithCurrentSong() {
        val payload = JSONObject()
            .put("type", "openSongCommand")
            .put("sequenceId", 4)
            .put(
                "currentSong",
                JSONObject().put(
                    "song",
                    JSONObject()
                        .put("title", "Correct Song")
                        .put("sourceType", "songsterr")
                        .put("source", "https://www.songsterr.com/a/wsa/correct-song-tab-s1")
                )
            )

        val command = ProtocolJson.parseOpenSongCommand(payload)

        assertNotNull(command)
        assertEquals(4, command?.sequenceId)
        assertEquals("Correct Song", command?.currentSong?.title)
        assertEquals("https://www.songsterr.com/a/wsa/correct-song-tab-s1", command?.currentSong?.source)
    }

    @Test
    fun parsesAlternateSongsterrUrlsAndResolvesByInstrument() {
        val payload = JSONObject()
            .put("type", "openSongCommand")
            .put("sequenceId", 4)
            .put(
                "currentSong",
                JSONObject().put(
                    "song",
                    JSONObject()
                        .put("title", "Beggin")
                        .put("sourceType", "songsterr")
                        .put("songsterrUrl", "https://www.songsterr.com/a/wsa/maneskin-beggin-tab-s488615")
                        .put("songsterrBassUrl", "https://www.songsterr.com/a/wsa/maneskin-beggin-bass-tab-s488615")
                        .put("songsterrDrumUrl", "https://www.songsterr.com/a/wsa/maneskin-beggin-easy-drum-tab-s5446545")
                )
            )

        val command = ProtocolJson.parseOpenSongCommand(payload)

        assertEquals(
            "https://www.songsterr.com/a/wsa/maneskin-beggin-tab-s488615",
            command?.currentSong?.songsterrReferenceForInstrument("guitar")
        )
        assertEquals(
            "https://www.songsterr.com/a/wsa/maneskin-beggin-bass-tab-s488615",
            command?.currentSong?.songsterrReferenceForInstrument("bass")
        )
        assertEquals(
            "https://www.songsterr.com/a/wsa/maneskin-beggin-easy-drum-tab-s5446545",
            command?.currentSong?.songsterrReferenceForInstrument("drum")
        )
    }

    @Test
    fun fallsBackToSlugRewriteWhenNoAlternateSongsterrUrlExists() {
        val song = CurrentSong(
            title = "Song",
            sourceType = "songsterr",
            source = null,
            songsterrUrl = "https://www.songsterr.com/a/wsa/song-tab-s100t3?track=3"
        )

        assertEquals(
            "https://www.songsterr.com/a/wsa/song-bass-tab-s100",
            song.songsterrReferenceForInstrument("bass")
        )
        assertEquals(
            "https://www.songsterr.com/a/wsa/song-drum-tab-s100",
            song.songsterrReferenceForInstrument("drum")
        )
    }
}
