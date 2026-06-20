package com.bandcue.songsterr

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.app.Activity

class MainActivity : Activity() {
    private lateinit var prefs: SharedPreferences
    private lateinit var roomInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var statusText: TextView
    private lateinit var detailText: TextView
    private lateinit var songText: TextView
    private lateinit var commandText: TextView
    private lateinit var permissionText: TextView

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            renderStatus(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("bandcue-songsterr", MODE_PRIVATE)
        buildUi()
        requestNotificationPermissionIfNeeded()
        // Resume automatically only when the user last left the adapter connected.
        // A user-initiated Disconnect clears this intent, so reopening the app
        // after Disconnect stays offline until Connect is pressed again.
        if (prefs.getBoolean(PREF_AUTO_CONNECT, false)) {
            connect()
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(BandCueAdapterService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter)
        }
    }

    override fun onStop() {
        unregisterReceiver(statusReceiver)
        super.onStop()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 36, 36, 36)
        }

        root.addView(TextView(this).apply {
            text = "BandCue Songsterr Adapter"
            textSize = 24f
            setTextColor(0xff1d2a24.toInt())
        })

        root.addView(TextView(this).apply {
            text = "Connect this Android device as a Songsterr transport adapter."
            textSize = 15f
            setPadding(0, 8, 0, 28)
        })

        roomInput = EditText(this).apply {
            hint = "Room URL, host:port, room code, or port"
            setSingleLine(true)
            setText(prefs.getString(PREF_ROOM, DEFAULT_ROOM_PORT.toString()))
        }
        root.addView(label("Room"))
        root.addView(roomInput)

        nameInput = EditText(this).apply {
            hint = "Device name"
            setSingleLine(true)
            setText(prefs.getString(PREF_NAME, "Android Songsterr"))
        }
        root.addView(label("Device name"))
        root.addView(nameInput)

        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 24, 0, 24)
        }
        controls.addView(Button(this).apply {
            text = "Connect"
            setOnClickListener { connect() }
        })
        controls.addView(Button(this).apply {
            text = "Disconnect"
            setOnClickListener { sendServiceAction(BandCueAdapterService.ACTION_DISCONNECT) }
        })
        root.addView(controls)

        root.addView(Button(this).apply {
            text = "Enable Notification Access"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        })

        root.addView(Button(this).apply {
            text = "Open Current Songsterr Song"
            setOnClickListener { sendServiceAction(BandCueAdapterService.ACTION_OPEN_CURRENT_SONG) }
        })

        root.addView(Button(this).apply {
            text = "Accessibility Fallback"
            setOnClickListener {
                startActivity(Intent(this@MainActivity, AccessibilityFallbackActivity::class.java))
            }
        })

        statusText = statusLine("Status", "not connected")
        detailText = statusLine("Detail", "Start the adapter and enable notification access.")
        permissionText = statusLine("Android", "notification access unknown, Songsterr unknown")
        songText = statusLine("Current song", "No current song")
        commandText = statusLine("Last command", "No command yet")

        root.addView(statusText)
        root.addView(detailText)
        root.addView(permissionText)
        root.addView(songText)
        root.addView(commandText)

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun connect() {
        val room = roomInput.text.toString().trim().ifEmpty { DEFAULT_ROOM_PORT.toString() }
        val deviceName = nameInput.text.toString().trim().ifEmpty { "Android Songsterr" }
        prefs.edit()
            .putString(PREF_ROOM, room)
            .putString(PREF_NAME, deviceName)
            .apply()

        val intent = Intent(this, BandCueAdapterService::class.java)
            .setAction(BandCueAdapterService.ACTION_CONNECT)
            .putExtra(BandCueAdapterService.EXTRA_ROOM_LOCATOR, room)
            .putExtra(BandCueAdapterService.EXTRA_DEVICE_NAME, deviceName)
        startAdapterService(intent)
    }

    private fun sendServiceAction(action: String) {
        startAdapterService(Intent(this, BandCueAdapterService::class.java).setAction(action))
    }

    private fun startAdapterService(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun renderStatus(intent: Intent) {
        val state = intent.getStringExtra(BandCueAdapterService.EXTRA_CONNECTION_STATE) ?: "unknown"
        val detail = intent.getStringExtra(BandCueAdapterService.EXTRA_CONNECTION_DETAIL) ?: ""
        val song = intent.getStringExtra(BandCueAdapterService.EXTRA_CURRENT_SONG) ?: "No current song"
        val command = intent.getStringExtra(BandCueAdapterService.EXTRA_LAST_COMMAND) ?: "No command yet"
        val notificationEnabled = intent.getBooleanExtra(BandCueAdapterService.EXTRA_NOTIFICATION_ENABLED, false)
        val accessibilityEnabled = intent.getBooleanExtra(BandCueAdapterService.EXTRA_ACCESSIBILITY_ENABLED, false)
        val songsterrInstalled = intent.getBooleanExtra(BandCueAdapterService.EXTRA_SONGSTERR_INSTALLED, false)

        statusText.text = "Status: $state"
        detailText.text = "Detail: $detail"
        permissionText.text = "Android: notification access ${if (notificationEnabled) "enabled" else "disabled"}, accessibility ${if (accessibilityEnabled) "enabled" else "disabled"}, Songsterr ${if (songsterrInstalled) "installed" else "missing"}"
        songText.text = "Current song: $song"
        commandText.text = "Last command: $command"
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    private fun label(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, 14, 0, 2)
    }

    private fun statusLine(label: String, value: String): TextView = TextView(this).apply {
        text = "$label: $value"
        textSize = 15f
        setPadding(0, 12, 0, 0)
    }

    private companion object {
        const val PREF_ROOM = "room"
        const val PREF_NAME = "name"
        const val PREF_AUTO_CONNECT = "autoConnect"
    }
}
