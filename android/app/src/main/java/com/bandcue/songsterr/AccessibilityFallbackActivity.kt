package com.bandcue.songsterr

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class AccessibilityFallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(36, 36, 36, 36)
        }
        root.addView(TextView(this).apply {
            text = "Accessibility fallback"
            textSize = 22f
        })
        root.addView(TextView(this).apply {
            text = "Enable BandCue Songsterr here when Songsterr does not expose usable Android media controls. BandCue will only tap visible Songsterr play and pause controls while Songsterr is the foreground app."
            textSize = 16f
            setPadding(0, 20, 0, 0)
        })
        root.addView(Button(this).apply {
            text = "Open Accessibility Settings"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        })
        setContentView(root)
    }
}
