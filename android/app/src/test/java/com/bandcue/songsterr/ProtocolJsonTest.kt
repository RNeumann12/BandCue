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
        assertEquals(true, capability.getBoolean("canSetTempo"))
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
                        .put("tempoPercent", 92)
                )
            )

        val command = ProtocolJson.parseTransportCommand(payload)

        assertNotNull(command)
        assertEquals("play", command?.action)
        assertEquals(3, command?.sequenceId)
        assertEquals(-50L, command?.manualOffsetMs)
        assertEquals(true, command?.resetBeforePlay)
        assertEquals("songsterr", command?.currentSong?.sourceType)
        assertEquals(92, command?.currentSong?.tempoPercent)
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
    fun parsesStartMeasureAndTempoFromTheCurrentSong() {
        val payload = JSONObject()
            .put("type", "transportCommand")
            .put("action", "play")
            .put("sequenceId", 7)
            .put("scheduledServerTime", 12_000)
            .put("resetBeforePlay", true)
            .put(
                "currentSong",
                JSONObject().put(
                    "song",
                    JSONObject()
                        .put("title", "Song")
                        .put("sourceType", "songsterr")
                        .put("startMeasure", 8)
                        .put("helixBpm", 120.0)
                        .put("helixBeatsPerMeasure", 4)
                )
            )

        val command = ProtocolJson.parseTransportCommand(payload)

        assertEquals(8, command?.startMeasure)
        // 7 measures of 4 beats at 120 BPM = 14 s.
        assertEquals(14_000L, command?.currentSong?.startPositionMs)
    }

    @Test
    fun treatsMeasureOneAsNoStartMeasure() {
        val song = JSONObject()
            .put("title", "Song")
            .put("sourceType", "songsterr")
            .put("startMeasure", 1)
        val payload = JSONObject()
            .put("type", "transportCommand")
            .put("action", "play")
            .put("resetBeforePlay", true)
            .put("currentSong", JSONObject().put("song", song))

        val command = ProtocolJson.parseTransportCommand(payload)

        assertEquals(null, command?.startMeasure)
        assertEquals(null, command?.currentSong?.startPositionMs)
    }

    @Test
    fun seeksOnlyWhenTheSessionSeeksAndTheSongHasATempo() {
        val withTempo = TransportCommand(
            action = "play",
            sequenceId = 1,
            scheduledServerTime = 0,
            manualOffsetMs = 0,
            resetBeforePlay = true,
            currentSong = CurrentSong("S", "songsterr", null, startMeasure = 8, bpm = 100.0, beatsPerMeasure = 4)
        )
        val withoutTempo = withTempo.copy(
            currentSong = CurrentSong("S", "songsterr", null, startMeasure = 8)
        )
        val fromTheTop = withTempo.copy(currentSong = CurrentSong("S", "songsterr", null))

        assertEquals(StartMeasurePlan.SeekToPosition, decideStartMeasurePlan(withTempo, controllerSupportsSeek = true))
        assertEquals(StartMeasurePlan.UnsupportedNoSeek, decideStartMeasurePlan(withTempo, controllerSupportsSeek = false))
        assertEquals(StartMeasurePlan.UnsupportedNoTempo, decideStartMeasurePlan(withoutTempo, controllerSupportsSeek = true))
        assertEquals(StartMeasurePlan.NotRequested, decideStartMeasurePlan(fromTheTop, controllerSupportsSeek = true))
    }

    @Test
    fun reportsTheMeasureItStartedFromInTheAdapterStatus() {
        val status = JSONObject(
            ProtocolJson.adapterStatus(
                ready = true,
                state = "last-command-succeeded",
                playback = "playing",
                title = "Song",
                detail = "ok",
                lastCommand = AdapterCommandStatus(
                    action = "play",
                    sequenceId = 2,
                    status = "succeeded",
                    at = 1,
                    detail = "ok",
                    startMeasure = 8
                )
            )
        )

        assertEquals(8, status.getJSONObject("lastCommand").getInt("startMeasure"))
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
