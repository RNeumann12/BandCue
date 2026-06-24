package com.bandcue.songsterr

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class BandCueAdapterService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val scheduler: ScheduledExecutorService = Executors.newScheduledThreadPool(2)
    private val samples = mutableListOf<ClockSample>()
    private var socket: BandCueWebSocketClient? = null
    private var clockTask: ScheduledFuture<*>? = null
    private var reconnectTask: ScheduledFuture<*>? = null
    private val commandTasks = Collections.synchronizedSet(mutableSetOf<ScheduledFuture<*>>())
    private var latestCommand: AdapterCommandStatus? = null
    private var currentSong: CurrentSong? = null
    private var roomLocator: String = DEFAULT_ROOM_PORT.toString()
    private var deviceName: String = "Android Songsterr"
    private var memberInstrument: String = "auto"
    private var serverOffsetMs = 0.0
    @Volatile private var shouldReconnect = false
    @Volatile private var connectionState = "not connected"
    @Volatile private var connectionDetail = "Enter a BandCue room URL, host:port, room code, or port."

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Not connected"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                roomLocator = intent.getStringExtra(EXTRA_ROOM_LOCATOR) ?: DEFAULT_ROOM_PORT.toString()
                deviceName = intent.getStringExtra(EXTRA_DEVICE_NAME)?.takeIf { it.isNotBlank() }
                    ?: "Android Songsterr"
                memberInstrument = normalizeInstrument(intent.getStringExtra(EXTRA_INSTRUMENT))
                shouldReconnect = true
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putBoolean(PREF_AUTO_CONNECT, true)
                    .putString(PREF_INSTRUMENT, memberInstrument)
                    .apply()
                connect()
            }
            ACTION_DISCONNECT -> {
                shouldReconnect = false
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putBoolean(PREF_AUTO_CONNECT, false)
                    .apply()
                disconnect("Disconnected. Android will stay offline until Connect is pressed.", stopService = true)
            }
            ACTION_OPEN_CURRENT_SONG -> {
                openCurrentSong()
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shouldReconnect = false
        disconnect("Service stopped")
        scheduler.shutdownNow()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun connect() {
        reconnectTask?.cancel(false)
        reconnectTask = null
        worker.execute {
            if (!shouldReconnect) {
                return@execute
            }
            disconnect("Reconnecting")
            connectionState = "connecting"
            connectionDetail = "Resolving BandCue room $roomLocator"
            publishUiStatus()

            try {
                val endpoint = resolveRoomEndpoint(roomLocator)
                if (!shouldReconnect) {
                    return@execute
                }
                connectionDetail = "Connecting to ${endpoint.roomUrl}"
                publishUiStatus()
                val client = BandCueWebSocketClient(endpoint.wsUrl, object : BandCueWebSocketClient.Listener {
                    override fun onOpen() {
                        connectionState = "connected"
                        connectionDetail = "Connected to BandCue coordinator"
                        socket?.sendText(ProtocolJson.clientHello(deviceName))
                        startClockSync()
                        publishAdapterStatus()
                        publishUiStatus()
                    }

                    override fun onText(message: String) {
                        handleServerMessage(message)
                    }

                    override fun onClosed(reason: String) {
                        connectionState = "disconnected"
                        connectionDetail = reason
                        stopClockSync()
                        publishUiStatus()
                        scheduleReconnect()
                    }

                    override fun onError(error: Throwable) {
                        connectionState = "error"
                        connectionDetail = error.message ?: error.javaClass.simpleName
                        stopClockSync()
                        publishUiStatus()
                        scheduleReconnect()
                    }
                })
                socket = client
                client.connect()
            } catch (error: Throwable) {
                connectionState = "error"
                connectionDetail = error.message ?: error.javaClass.simpleName
                publishAdapterStatus()
                publishUiStatus()
                scheduleReconnect()
            }
        }
    }

    private fun disconnect(detail: String, stopService: Boolean = false) {
        reconnectTask?.cancel(false)
        reconnectTask = null
        stopClockSync()
        cancelCommandTasks()
        socket?.close()
        socket = null
        connectionState = "disconnected"
        connectionDetail = detail
        publishUiStatus()
        if (stopService) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) {
            return
        }
        reconnectTask?.cancel(false)
        reconnectTask = scheduler.schedule({ connect() }, 2, TimeUnit.SECONDS)
    }

    private fun startClockSync() {
        stopClockSync()
        clockTask = scheduler.scheduleAtFixedRate({
            socket?.sendText(ProtocolJson.clockSync(System.currentTimeMillis()))
        }, 0, 1, TimeUnit.SECONDS)
    }

    private fun stopClockSync() {
        clockTask?.cancel(false)
        clockTask = null
    }

    private fun scheduleCommandTask(task: () -> Unit, delay: Long, unit: TimeUnit) {
        var future: ScheduledFuture<*>? = null
        future = scheduler.schedule({
            try {
                if (shouldReconnect) {
                    task()
                }
            } finally {
                future?.let { commandTasks.remove(it) }
            }
        }, delay, unit)
        future?.let { commandTasks.add(it) }
    }

    private fun cancelCommandTasks() {
        val snapshot = synchronized(commandTasks) { commandTasks.toList() }
        snapshot.forEach { it.cancel(false) }
        commandTasks.clear()
    }

    private fun handleServerMessage(raw: String) {
        val message = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }

        when (message.optString("type")) {
            "clockSyncResult" -> handleClockSyncResult(message)
            "roomState" -> {
                currentSong = ProtocolJson.parseCurrentSong(message)
                publishAdapterStatus()
                publishUiStatus()
            }
            "transportCommand" -> {
                val command = ProtocolJson.parseTransportCommand(message) ?: return
                currentSong = command.currentSong ?: currentSong
                handleTransportCommand(command)
            }
            "openSongCommand" -> {
                val command = ProtocolJson.parseOpenSongCommand(message) ?: return
                currentSong = command.currentSong ?: currentSong
                handleOpenSongCommand(command)
            }
            "error" -> {
                connectionDetail = message.optString("message", connectionDetail)
                publishUiStatus()
            }
        }
    }

    private fun handleClockSyncResult(message: JSONObject) {
        val sample = calculateClockSample(
            clientSentAt = message.optLong("clientSentAt"),
            clientReceivedAt = System.currentTimeMillis(),
            serverReceivedAt = message.optLong("serverReceivedAt"),
            serverSentAt = message.optLong("serverSentAt")
        )
        samples.add(sample)
        while (samples.size > 10) {
            samples.removeAt(0)
        }
        val summary = summarizeClock(samples)
        serverOffsetMs = summary.offsetMs
        socket?.sendText(
            ProtocolJson.clockStatus(
                rttMs = summary.rttMs,
                offsetMs = summary.offsetMs,
                jitterMs = calculateJitterMs(samples)
            )
        )
    }

    private fun handleTransportCommand(command: TransportCommand) {
        val scheduled = scheduleTransportCommand(
            action = command.action,
            sequenceId = command.sequenceId,
            scheduledServerTime = command.scheduledServerTime,
            manualOffsetMs = command.manualOffsetMs,
            localNow = System.currentTimeMillis(),
            serverOffsetMs = serverOffsetMs
        )

        latestCommand = AdapterCommandStatus(
            action = command.action,
            sequenceId = command.sequenceId,
            status = "pending",
            at = System.currentTimeMillis(),
            detail = "Songsterr ${command.action} scheduled on Android",
            controlPath = "android-media-session"
        )
        publishAdapterStatus(stateOverride = "command-pending")
        publishUiStatus()

        val songUrl = command.currentSong?.songsterrReferenceForInstrument(effectiveSongsterrInstrument())
        val openedSongForCommand = if (!songUrl.isNullOrBlank() && findSongsterrController() == null && shouldOpenSongForCommand()) {
            openSongsterrUrl(songUrl)
        } else {
            false
        }

        val scheduledDelayMs = (scheduled.dueLocalAt - System.currentTimeMillis()).coerceAtLeast(0)
        val delayMs = if (openedSongForCommand && BandCueAccessibilityService.isEnabled()) {
            scheduledDelayMs.coerceAtLeast(SONGSTERR_OPEN_SETTLE_MS)
        } else {
            scheduledDelayMs
        }
        scheduleCommandTask({
            executeTransport(command)
        }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun handleOpenSongCommand(command: OpenSongCommand) {
        val song = command.currentSong
        latestCommand = AdapterCommandStatus(
            action = "open-song",
            sequenceId = command.sequenceId,
            status = "pending",
            at = System.currentTimeMillis(),
            detail = "Opening current Songsterr song on Android",
            controlPath = "android-intent"
        )
        publishAdapterStatus(stateOverride = "command-pending")
        publishUiStatus()

        val songUrl = song?.songsterrReferenceForInstrument(effectiveSongsterrInstrument())
        if (songUrl.isNullOrBlank()) {
            latestCommand = AdapterCommandStatus(
                action = "open-song",
                sequenceId = command.sequenceId,
                status = "failed",
                at = System.currentTimeMillis(),
                detail = "Current song does not have a usable Songsterr URL.",
                controlPath = "android-intent"
            )
            publishAdapterStatus(stateOverride = "last-command-failed")
            publishUiStatus()
            return
        }

        val opened = openSongsterrUrl(songUrl)
        latestCommand = AdapterCommandStatus(
            action = "open-song",
            sequenceId = command.sequenceId,
            status = if (opened) "succeeded" else "failed",
            at = System.currentTimeMillis(),
            detail = if (opened) {
                "Opened Songsterr for ${song.title.ifBlank { "current song" }}."
            } else {
                "Android could not open the current Songsterr URL."
            },
            controlPath = "android-intent"
        )
        publishAdapterStatus(stateOverride = if (opened) "last-command-succeeded" else "last-command-failed")
        publishUiStatus()
    }

    private fun shouldOpenSongForCommand(): Boolean {
        if (!BandCueAccessibilityService.isEnabled()) {
            return true
        }
        return BandCueAccessibilityService.foregroundPackageName() != SONGSTERR_PACKAGE
    }

    private fun executeTransport(command: TransportCommand) {
        val now = System.currentTimeMillis()
        val controller = if (isNotificationListenerEnabled()) findSongsterrController() else null

        // Songsterr's media session does not advertise ACTION_SEEK_TO, so a play
        // command that must restart from the top cannot reset through the
        // session. When that is the case and the accessibility fallback is
        // available, route through it so it can tap Songsterr's reset-to-start
        // button before playing. Plain play/stop still prefer the media session.
        val wantsReset = command.action == "play" && command.resetBeforePlay
        val canSeek = controller != null && controllerSupportsSeek(controller)
        val resetNeedsAccessibility = wantsReset && !canSeek && BandCueAccessibilityService.isEnabled()

        if (command.action == "stop") {
            val stopPlan = decideStopControlPlan(
                playbackState = playbackFromController(controller),
                hasMediaController = controller != null,
                accessibilityEnabled = BandCueAccessibilityService.isEnabled()
            )
            when (stopPlan) {
                StopControlPlan.NoOpAlreadyStopped -> {
                    latestCommand = AdapterCommandStatus(
                        action = command.action,
                        sequenceId = command.sequenceId,
                        status = "succeeded",
                        at = now,
                        detail = "Songsterr playback is already stopped; Stop was a no-op.",
                        controlPath = "no-op"
                    )
                    publishAdapterStatus(
                        stateOverride = "last-command-succeeded",
                        playbackOverride = "stopped"
                    )
                    publishUiStatus()
                    return
                }
                StopControlPlan.FailClosed -> {
                    reportCommandResult(
                        command = command,
                        status = "failed",
                        detail = "Could not confirm Songsterr is playing and no safe pause/stop control is available.",
                        controlPath = "none"
                    )
                    return
                }
                StopControlPlan.MediaSessionPause,
                StopControlPlan.AccessibilityConfidentPauseOnly -> Unit
            }
        }

        if (controller != null && !resetNeedsAccessibility) {
            try {
                if (command.action == "play") {
                    if (wantsReset && canSeek) {
                        controller.transportControls.seekTo(0)
                    }
                    controller.transportControls.play()
                } else {
                    controller.transportControls.pause()
                }
                latestCommand = AdapterCommandStatus(
                    action = command.action,
                    sequenceId = command.sequenceId,
                    status = "succeeded",
                    at = now,
                    detail = if (command.action == "play") {
                        if (wantsReset && canSeek) {
                            "Requested Songsterr seek to start and playback through Android media session."
                        } else if (wantsReset) {
                            "Played through Android media session; the session offers no seek, so position was not reset."
                        } else {
                            "Requested Songsterr playback through Android media session."
                        }
                    } else {
                        "Requested Songsterr pause through Android media session."
                    },
                    controlPath = "android-media-session"
                )
                publishAdapterStatus(
                    stateOverride = "last-command-succeeded",
                    playbackOverride = if (command.action == "play") "playing" else "stopped"
                )
                publishUiStatus()
                return
            } catch (_: Throwable) {
                // Fall through to accessibility; Songsterr's media session is not reliable on all devices.
            }
        }

        val accessibilityResult = BandCueAccessibilityService.control(
            command.action,
            command.resetBeforePlay
        )
        if (accessibilityResult.ok) {
            latestCommand = AdapterCommandStatus(
                action = command.action,
                sequenceId = command.sequenceId,
                status = "succeeded",
                at = now,
                detail = accessibilityResult.detail,
                controlPath = accessibilityResult.controlPath
            )
            publishAdapterStatus(
                stateOverride = "last-command-succeeded",
                playbackOverride = if (command.action == "play") "playing" else "stopped"
            )
            publishUiStatus()
            return
        }

        val permissionHint = when {
            !isNotificationListenerEnabled() && !BandCueAccessibilityService.isEnabled() ->
                "Enable Notification Access or Accessibility fallback for BandCue Songsterr."
            !BandCueAccessibilityService.isEnabled() ->
                "No active Songsterr media session found. Enable Accessibility fallback for BandCue Songsterr."
            else -> accessibilityResult.detail
        }
        reportCommandResult(
            command = command,
            status = "failed",
            detail = permissionHint,
            controlPath = accessibilityResult.controlPath
        )
    }

    private fun reportCommandResult(
        command: TransportCommand,
        status: String,
        detail: String,
        controlPath: String
    ) {
        latestCommand = AdapterCommandStatus(
            action = command.action,
            sequenceId = command.sequenceId,
            status = status,
            at = System.currentTimeMillis(),
            detail = detail,
            controlPath = controlPath
        )
        publishAdapterStatus(stateOverride = if (status == "succeeded") "last-command-succeeded" else "last-command-failed")
        publishUiStatus()
    }

    private fun publishAdapterStatus(
        stateOverride: String? = null,
        playbackOverride: String? = null
    ) {
        val songsterrInstalled = isSongsterrInstalled()
        val notificationEnabled = isNotificationListenerEnabled()
        val controller = if (notificationEnabled) findSongsterrController() else null
        val playback = playbackOverride ?: playbackFromController(controller)
        val songUrl = currentSong?.songsterrReferenceForInstrument(effectiveSongsterrInstrument())
        val songOpenable = !songUrl.isNullOrBlank() && canOpenSongsterrUrl(songUrl)
        val title = mediaTitle(controller) ?: currentSong?.title

        val readiness = when {
            !songsterrInstalled -> Readiness(false, "not-ready", "Songsterr Android app is not installed.")
            !notificationEnabled && !BandCueAccessibilityService.isEnabled() -> Readiness(false, "not-ready", "Enable Notification Access or Accessibility fallback.")
            controller != null -> Readiness(true, stateOverride ?: "ready", "Songsterr media session detected via android-media-session.")
            BandCueAccessibilityService.isEnabled() -> Readiness(true, stateOverride ?: "ready", "Accessibility fallback enabled; Songsterr controls can be tapped when foreground.")
            songOpenable -> Readiness(true, stateOverride ?: "ready", "Songsterr can be opened for the current song; waiting for a media session.")
            else -> Readiness(false, "not-ready", "No Songsterr media session found and no Songsterr URL is current.")
        }

        socket?.sendText(
            ProtocolJson.adapterStatus(
                ready = readiness.ready,
                state = readiness.state,
                playback = playback,
                title = title,
                detail = readiness.detail,
                lastCommand = latestCommand
            )
        )
    }

    private fun findSongsterrController(): MediaController? {
        return try {
            val manager = getSystemService(MediaSessionManager::class.java)
            val component = ComponentName(this, BandCueNotificationListenerService::class.java)
            manager.getActiveSessions(component)
                .firstOrNull { it.packageName == SONGSTERR_PACKAGE }
        } catch (_: SecurityException) {
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun controllerSupportsSeek(controller: MediaController): Boolean {
        val actions = controller.playbackState?.actions ?: 0L
        return actions and PlaybackState.ACTION_SEEK_TO != 0L
    }

    private fun playbackFromController(controller: MediaController?): String {
        return when (controller?.playbackState?.state) {
            PlaybackState.STATE_PLAYING,
            PlaybackState.STATE_BUFFERING,
            PlaybackState.STATE_FAST_FORWARDING,
            PlaybackState.STATE_REWINDING -> "playing"
            PlaybackState.STATE_PAUSED,
            PlaybackState.STATE_STOPPED,
            PlaybackState.STATE_NONE -> "stopped"
            else -> "unknown"
        }
    }

    private fun mediaTitle(controller: MediaController?): String? {
        val title = controller?.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE)
        val artist = controller?.metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST)
        return when {
            !title.isNullOrBlank() && !artist.isNullOrBlank() -> "$artist - $title"
            !title.isNullOrBlank() -> title
            else -> null
        }
    }

    private fun openCurrentSong() {
        val source = currentSong?.songsterrReferenceForInstrument(effectiveSongsterrInstrument())
        if (source.isNullOrBlank()) {
            connectionDetail = "No current Songsterr URL to open."
            publishUiStatus()
            return
        }
        openSongsterrUrl(source)
    }

    private fun openSongsterrUrl(value: String): Boolean {
        return try {
            val uri = Uri.parse(value)
            val preferred = Intent(Intent.ACTION_VIEW, uri)
                .setPackage(SONGSTERR_PACKAGE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val intent = if (preferred.resolveActivity(packageManager) != null) {
                preferred
            } else {
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun effectiveSongsterrInstrument(): String {
        return if (memberInstrument == "auto") "guitar" else memberInstrument
    }

    private fun canOpenSongsterrUrl(value: String): Boolean {
        return try {
            val uri = Uri.parse(value)
            val preferred = Intent(Intent.ACTION_VIEW, uri).setPackage(SONGSTERR_PACKAGE)
            preferred.resolveActivity(packageManager) != null ||
                Intent(Intent.ACTION_VIEW, uri).resolveActivity(packageManager) != null
        } catch (_: Exception) {
            false
        }
    }

    private fun isSongsterrInstalled(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(
                    SONGSTERR_PACKAGE,
                    PackageManager.PackageInfoFlags.of(0)
                )
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(SONGSTERR_PACKAGE, 0)
            }
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun isNotificationListenerEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
            ?: return false
        return enabled.split(":").any {
            ComponentName.unflattenFromString(it)?.packageName == packageName
        }
    }

    private fun publishUiStatus() {
        val status = Intent(ACTION_STATUS)
            .setPackage(packageName)
            .putExtra(EXTRA_CONNECTION_STATE, connectionState)
            .putExtra(EXTRA_CONNECTION_DETAIL, connectionDetail)
            .putExtra(EXTRA_ROOM_LOCATOR, roomLocator)
            .putExtra(EXTRA_DEVICE_NAME, deviceName)
            .putExtra(EXTRA_CURRENT_SONG, currentSong?.title ?: "No current song")
            .putExtra(EXTRA_LAST_COMMAND, latestCommand?.let { "${it.action} ${it.status}: ${it.detail}" } ?: "No command yet")
            .putExtra(EXTRA_NOTIFICATION_ENABLED, isNotificationListenerEnabled())
            .putExtra(EXTRA_ACCESSIBILITY_ENABLED, BandCueAccessibilityService.isEnabled())
            .putExtra(EXTRA_SONGSTERR_INSTALLED, isSongsterrInstalled())
        sendBroadcast(status)
        updateNotification()
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification("$connectionState - $connectionDetail"))
    }

    private fun buildNotification(text: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text.take(120))
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private data class Readiness(
        val ready: Boolean,
        val state: String,
        val detail: String
    )

    companion object {
        const val ACTION_CONNECT = "com.bandcue.songsterr.CONNECT"
        const val ACTION_DISCONNECT = "com.bandcue.songsterr.DISCONNECT"
        const val ACTION_OPEN_CURRENT_SONG = "com.bandcue.songsterr.OPEN_CURRENT_SONG"
        const val ACTION_STATUS = "com.bandcue.songsterr.STATUS"
        const val EXTRA_ROOM_LOCATOR = "roomLocator"
        const val EXTRA_DEVICE_NAME = "deviceName"
        const val EXTRA_INSTRUMENT = "instrument"
        const val EXTRA_CONNECTION_STATE = "connectionState"
        const val EXTRA_CONNECTION_DETAIL = "connectionDetail"
        const val EXTRA_CURRENT_SONG = "currentSong"
        const val EXTRA_LAST_COMMAND = "lastCommand"
        const val EXTRA_NOTIFICATION_ENABLED = "notificationEnabled"
        const val EXTRA_ACCESSIBILITY_ENABLED = "accessibilityEnabled"
        const val EXTRA_SONGSTERR_INSTALLED = "songsterrInstalled"

        private const val CHANNEL_ID = "bandcue-adapter"
        private const val NOTIFICATION_ID = 4731
        private const val SONGSTERR_PACKAGE = "com.songsterr"
        private const val SONGSTERR_OPEN_SETTLE_MS = 1500L
        private const val PREFS_NAME = "bandcue-songsterr"
        private const val PREF_AUTO_CONNECT = "autoConnect"
        private const val PREF_INSTRUMENT = "instrument"
    }
}
