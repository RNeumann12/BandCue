package com.bandcue.songsterr

import org.json.JSONArray
import org.json.JSONObject

data class CurrentSong(
    val title: String,
    val sourceType: String,
    val source: String?
)

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

data class AdapterCommandStatus(
    val action: String,
    val sequenceId: Int,
    val status: String,
    val at: Long,
    val detail: String,
    val controlPath: String? = null
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

    fun clockStatus(rttMs: Double, offsetMs: Double, jitterMs: Double): String = JSONObject()
        .put("type", "clockStatus")
        .put("rttMs", rttMs)
        .put("offsetMs", offsetMs)
        .put("jitterMs", jitterMs)
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
            ?.let {
                CurrentSong(
                    title = it.optString("title"),
                    sourceType = it.optString("sourceType"),
                    source = it.optString("source").takeIf { source -> source.isNotBlank() }
                )
            }

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
            ?.let {
                CurrentSong(
                    title = it.optString("title"),
                    sourceType = it.optString("sourceType"),
                    source = it.optString("source").takeIf { source -> source.isNotBlank() }
                )
            }

        return OpenSongCommand(
            sequenceId = message.optInt("sequenceId"),
            currentSong = song
        )
    }

    fun parseCurrentSong(message: JSONObject): CurrentSong? {
        val song = when (message.optString("type")) {
            "roomState" -> message.optJSONObject("currentSong")?.optJSONObject("song")
            else -> null
        } ?: return null

        return CurrentSong(
            title = song.optString("title"),
            sourceType = song.optString("sourceType"),
            source = song.optString("source").takeIf { it.isNotBlank() }
        )
    }
}
