package com.bandcue.songsterr

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

data class CurrentSong(
    val title: String,
    val sourceType: String,
    val source: String?,
    val songsterrUrl: String? = null,
    val songsterrBassUrl: String? = null,
    val songsterrDrumUrl: String? = null
) {
    /**
     * Resolve the Songsterr URL for this song, mirroring
     * src/shared/song-sources.ts: the dedicated songsterrUrl field wins,
     * otherwise the primary source is used when sourceType is "songsterr". Lets
     * a single setlist entry target both Songsterr and MuseScore at once.
     */
    val songsterrReference: String?
        get() = songsterrReferenceForInstrument("guitar")

    fun songsterrReferenceForInstrument(instrument: String): String? {
        val normalized = normalizeInstrument(instrument)
        val explicit = when (normalized) {
            "bass" -> songsterrBassUrl?.takeIf { it.isNotBlank() }
            "drum" -> songsterrDrumUrl?.takeIf { it.isNotBlank() }
            else -> null
        }
        if (!explicit.isNullOrBlank()) {
            return explicit
        }

        val default = songsterrUrl?.takeIf { it.isNotBlank() }
            ?: source?.takeIf { sourceType == "songsterr" && it.isNotBlank() }
            ?: return null
        return if (normalized == "guitar") default else applySongsterrInstrument(default, normalized)
    }
}

data class TransportCommand(
    val action: String,
    val sequenceId: Int,
    val scheduledServerTime: Long,
    val manualOffsetMs: Long,
    val resetBeforePlay: Boolean,
    val currentSong: CurrentSong?
)

data class OpenSongCommand(
    val sequenceId: Int,
    val currentSong: CurrentSong?
)

data class TransportStateSnapshot(
    val status: String,
    val action: String?,
    val sequenceId: Int,
    val scheduledServerTime: Long,
    val stopReason: String?
)

data class AdapterCommandStatus(
    val action: String,
    val sequenceId: Int,
    val status: String,
    val at: Long,
    val detail: String,
    val controlPath: String? = null,
    // When the control action actually executed, in server time; lets the host
    // show this device's start deviation from the scheduled downbeat.
    val firedAtServerTime: Long? = null
)

object ProtocolJson {
    fun clientHello(deviceName: String): String = JSONObject()
        .put("type", "clientHello")
        .put("deviceName", deviceName)
        .put("role", "desktop-adapter")
        .put(
            "capabilities",
            JSONArray().put(
                JSONObject()
                    .put("app", "songsterr")
                    .put("canPlay", true)
                    .put("canStop", true)
            )
        )
        .toString()

    fun clockSync(clientSentAt: Long): String = JSONObject()
        .put("type", "clockSync")
        .put("clientSentAt", clientSentAt)
        .toString()

    fun clockStatus(rttMs: Double, offsetMs: Double, jitterMs: Double, sampleCount: Int): String = JSONObject()
        .put("type", "clockStatus")
        .put("rttMs", rttMs)
        .put("offsetMs", offsetMs)
        .put("jitterMs", jitterMs)
        .put("sampleCount", sampleCount)
        .toString()

    fun adapterStatus(
        ready: Boolean,
        state: String,
        playback: String,
        title: String?,
        detail: String,
        lastCommand: AdapterCommandStatus? = null
    ): String {
        val payload = JSONObject()
            .put("type", "adapterStatus")
            .put("ready", ready)
            .put("app", "songsterr")
            .put("state", state)
            .put("playback", playback)
            .put("detail", detail)

        if (!title.isNullOrBlank()) {
            payload.put("title", title)
        }

        if (lastCommand != null) {
            val command = JSONObject()
                .put("action", lastCommand.action)
                .put("sequenceId", lastCommand.sequenceId)
                .put("status", lastCommand.status)
                .put("at", lastCommand.at)
                .put("detail", lastCommand.detail)
            if (!lastCommand.controlPath.isNullOrBlank()) {
                command.put("controlPath", lastCommand.controlPath)
            }
            if (lastCommand.firedAtServerTime != null) {
                command.put("firedAtServerTime", lastCommand.firedAtServerTime)
            }
            payload.put("lastCommand", command)
        }

        return payload.toString()
    }

    fun parseTransportCommand(message: JSONObject): TransportCommand? {
        if (message.optString("type") != "transportCommand") {
            return null
        }

        val song = message
            .optJSONObject("currentSong")
            ?.optJSONObject("song")
            ?.let { parseSong(it) }

        return TransportCommand(
            action = message.optString("action"),
            sequenceId = message.optInt("sequenceId"),
            scheduledServerTime = message.optLong("scheduledServerTime"),
            manualOffsetMs = message.optLong("manualOffsetMs", 0),
            resetBeforePlay = message.optBoolean("resetBeforePlay", false),
            currentSong = song
        )
    }

    fun parseOpenSongCommand(message: JSONObject): OpenSongCommand? {
        if (message.optString("type") != "openSongCommand") {
            return null
        }

        val song = message
            .optJSONObject("currentSong")
            ?.optJSONObject("song")
            ?.let { parseSong(it) }

        return OpenSongCommand(
            sequenceId = message.optInt("sequenceId"),
            currentSong = song
        )
    }

    fun parseServerHelloClientId(message: JSONObject): String? {
        if (message.optString("type") != "serverHello") {
            return null
        }
        return message.optString("clientId").takeIf { it.isNotBlank() }
    }

    fun parseTransportState(message: JSONObject): TransportStateSnapshot? {
        if (message.optString("type") != "roomState") {
            return null
        }
        val transport = message.optJSONObject("transport") ?: return null
        return TransportStateSnapshot(
            status = transport.optString("status"),
            action = transport.optString("action").takeIf { it.isNotBlank() },
            sequenceId = transport.optInt("sequenceId"),
            scheduledServerTime = transport.optLong("scheduledServerTime", 0L),
            stopReason = transport.optString("stopReason").takeIf { it.isNotBlank() }
        )
    }

    /** This client's manual calibration offset from a roomState clients list. */
    fun parseManualOffsetForClient(message: JSONObject, clientId: String?): Long {
        if (clientId.isNullOrBlank()) {
            return 0L
        }
        val clients = message.optJSONArray("clients") ?: return 0L
        for (index in 0 until clients.length()) {
            val client = clients.optJSONObject(index) ?: continue
            if (client.optString("id") == clientId) {
                return client.optJSONObject("clock")?.optLong("manualOffsetMs", 0L) ?: 0L
            }
        }
        return 0L
    }

    fun parseCurrentSong(message: JSONObject): CurrentSong? {
        val song = when (message.optString("type")) {
            "roomState" -> message.optJSONObject("currentSong")?.optJSONObject("song")
            else -> null
        } ?: return null

        return parseSong(song)
    }

    private fun parseSong(song: JSONObject): CurrentSong = CurrentSong(
        title = song.optString("title"),
        sourceType = song.optString("sourceType"),
        source = song.optString("source").takeIf { it.isNotBlank() },
        songsterrUrl = song.optString("songsterrUrl").takeIf { it.isNotBlank() },
        songsterrBassUrl = song.optString("songsterrBassUrl").takeIf { it.isNotBlank() },
        songsterrDrumUrl = song.optString("songsterrDrumUrl").takeIf { it.isNotBlank() }
    )
}

fun normalizeInstrument(value: String?): String = when (value) {
    "guitar", "bass", "drum" -> value
    else -> "auto"
}

fun applySongsterrInstrument(value: String, instrument: String): String {
    return try {
        val uri = URI(value)
        var path = (uri.rawPath ?: "")
            .replace(Regex("-(?:bass|drum)-tab(-s\\d+)", RegexOption.IGNORE_CASE), "-tab$1")
            .replace(Regex("(-s\\d+)t\\d+", RegexOption.IGNORE_CASE), "$1")
        path = when (instrument) {
            "bass" -> path.replace(Regex("-tab(-s\\d+)", RegexOption.IGNORE_CASE), "-bass-tab$1")
            "drum" -> path.replace(Regex("-tab(-s\\d+)", RegexOption.IGNORE_CASE), "-drum-tab$1")
            else -> path
        }
        val query = uri.rawQuery
            ?.split("&")
            ?.filterNot { it.substringBefore("=").equals("track", ignoreCase = true) }
            ?.joinToString("&")
            ?.takeIf { it.isNotBlank() }
        URI(uri.scheme, uri.rawAuthority, path, query, uri.rawFragment).toString()
    } catch (_: Exception) {
        value
    }
}
