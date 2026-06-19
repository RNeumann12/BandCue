package com.bandcue.songsterr

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.PointF
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

data class AccessibilityControlResult(
    val ok: Boolean,
    val detail: String,
    val controlPath: String = "android-accessibility"
)

class BandCueAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        activeService = this
    }

    override fun onDestroy() {
        if (activeService === this) {
            activeService = null
        }
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    private fun controlSongsterr(action: String, resetBeforePlay: Boolean): AccessibilityControlResult {
        val root = rootInActiveWindow
            ?: return AccessibilityControlResult(false, "Accessibility fallback could not read the active window.")
        val foregroundPackage = root.packageName?.toString().orEmpty()
        if (foregroundPackage != SONGSTERR_PACKAGE) {
            return AccessibilityControlResult(
                ok = false,
                detail = "Songsterr is not the foreground app; active package is ${foregroundPackage.ifBlank { "unknown" }}."
            )
        }
        if (isSpeedSettingsOpen(root)) {
            return AccessibilityControlResult(
                ok = false,
                detail = "Songsterr playback speed settings are open. Close that sheet and retry play/stop."
            )
        }

        val resetDetail = if (action == "play" && resetBeforePlay) {
            resetSongsterrToStart(root)
        } else {
            null
        }
        val candidate = findBestTransportCandidate(root, action)
            ?: return AccessibilityControlResult(
                ok = false,
                detail = "Accessibility fallback could not find a visible Songsterr ${actionLabel(action)} control."
            )

        val clickTarget = clickableSelfOrAncestor(candidate.node)
            ?: return AccessibilityControlResult(
                ok = false,
                detail = "Accessibility fallback found ${candidate.label}, but it was not clickable."
            )

        val clicked = if (candidate.tapOnly) {
            tapCenterOf(candidate.bounds)
        } else {
            clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK) ||
                tapCenterOf(candidate.bounds)
        }
        return if (clicked) {
            AccessibilityControlResult(
                ok = true,
                detail = listOfNotNull(
                    resetDetail,
                    "Tapped Songsterr control: ${candidate.label.ifBlank { actionLabel(action) }}."
                ).joinToString(" ")
            )
        } else {
            AccessibilityControlResult(false, "Songsterr rejected the accessibility click on ${candidate.label}.")
        }
    }

    private fun resetSongsterrToStart(root: AccessibilityNodeInfo): String {
        val progress = findProgressCandidate(root)
            ?: return "Tried to reset Songsterr to the song start; no visible progress control was exposed."

        val setProgress = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            val args = Bundle().apply {
                putFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE, 0f)
            }
            progress.node.performAction(ACTION_SET_PROGRESS, args)
        } else {
            false
        }
        if (setProgress) {
            return "Reset Songsterr progress to the song start."
        }

        val dragged = dragToStart(progress.bounds)
        return if (dragged) {
            "Dragged Songsterr progress to the song start."
        } else {
            "Tried to reset Songsterr to the song start, but the progress control did not respond."
        }
    }

    private fun findProgressCandidate(root: AccessibilityNodeInfo): ProgressCandidate? {
        val candidates = mutableListOf<ProgressCandidate>()
        collectProgressCandidates(root, candidates)
        return candidates.maxByOrNull { it.score }
    }

    private fun collectProgressCandidates(
        node: AccessibilityNodeInfo?,
        candidates: MutableList<ProgressCandidate>
    ) {
        if (node == null) {
            return
        }

        if (node.packageName?.toString() == SONGSTERR_PACKAGE && node.isVisibleToUser) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val label = nodeLabel(node)
            val className = node.className?.toString().orEmpty()
            val rangeBonus = if (node.rangeInfo != null) 10 else 0
            val classBonus = if (
                className.contains("SeekBar", ignoreCase = true) ||
                className.contains("ProgressBar", ignoreCase = true) ||
                label.contains("progress", ignoreCase = true) ||
                label.contains("seek", ignoreCase = true)
            ) 6 else 0
            val shapeBonus = if (bounds.width() > resources.displayMetrics.widthPixels * 0.45 && bounds.height() <= 120) {
                4
            } else {
                0
            }
            val score = rangeBonus + classBonus + shapeBonus
            if (score > 0 && bounds.width() > 120 && bounds.height() > 0) {
                candidates.add(ProgressCandidate(node, bounds, score))
            }
        }

        for (index in 0 until node.childCount) {
            collectProgressCandidates(node.getChild(index), candidates)
        }
    }

    private fun findBestTransportCandidate(
        root: AccessibilityNodeInfo,
        action: String
    ): TransportCandidate? {
        val candidates = mutableListOf<TransportCandidate>()
        collectTransportCandidates(root, action, candidates)
        return candidates.maxByOrNull { it.score }
            ?: findStructuredTransportCandidate(root)
            ?: findGeometryTransportCandidate(root)
    }

    private fun collectTransportCandidates(
        node: AccessibilityNodeInfo?,
        action: String,
        candidates: MutableList<TransportCandidate>
    ) {
        if (node == null) {
            return
        }

        val label = nodeLabel(node)
        val score = scoreTransportCandidate(node, label, action)
        if (score > 0) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            candidates.add(TransportCandidate(node, label, bounds, score))
        }

        for (index in 0 until node.childCount) {
            collectTransportCandidates(node.getChild(index), action, candidates)
        }
    }

    private fun scoreTransportCandidate(
        node: AccessibilityNodeInfo,
        label: String,
        action: String
    ): Int {
        if (!node.isVisibleToUser || label.isBlank()) {
            return 0
        }

        val lower = label.lowercase()
        if (IGNORED_CONTROL_WORDS.any { Regex("\\b$it\\b").containsMatchIn(lower) }) {
            return 0
        }

        val words = if (action == "play") {
            listOf("play", "resume", "start")
        } else {
            listOf("pause", "stop")
        }
        val exact = words.any { lower == it }
        val contains = words.any { Regex("\\b$it\\b").containsMatchIn(lower) }
        if (!exact && !contains) {
            return 0
        }

        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val clickableBonus = if (clickableSelfOrAncestor(node) != null) 5 else 0
        val classBonus = if (node.className?.contains("Button", ignoreCase = true) == true) 3 else 0
        val lowerScreenBonus = if (bounds.top > resources.displayMetrics.heightPixels * 0.30) 2 else 0
        val exactBonus = if (exact) 10 else 4
        return exactBonus + clickableBonus + classBonus + lowerScreenBonus
    }

    private fun findGeometryTransportCandidate(root: AccessibilityNodeInfo): TransportCandidate? {
        val candidates = mutableListOf<TransportCandidate>()
        collectGeometryCandidates(root, candidates)
        val screenWidth = resources.displayMetrics.widthPixels
        val targetX = screenWidth * 0.69
        return candidates
            .filter { it.bounds.centerX() in (screenWidth * 0.58).toInt()..(screenWidth * 0.76).toInt() }
            .sortedWith(
                compareByDescending<TransportCandidate> { it.bounds.centerY() }
                    .thenBy { kotlin.math.abs(it.bounds.centerX() - targetX) }
            )
            .firstOrNull()
    }

    private fun findStructuredTransportCandidate(root: AccessibilityNodeInfo): TransportCandidate? {
        val candidates = mutableListOf<TransportCandidate>()
        collectToolbarCandidates(root, candidates)
        val rows = candidates
            .groupBy { it.bounds.centerY() / TOOLBAR_ROW_BUCKET_PX }
            .values
            .map { row -> row.sortedBy { it.bounds.centerX() } }
            .sortedByDescending { row -> row.maxOf { it.bounds.centerY() } }

        for (row in rows) {
            val speed = row.firstOrNull { looksLikeSpeedControl(it.subtreeLabel) }
            val mode = row.firstOrNull { looksLikeModeControl(it.subtreeLabel) }
            if (speed == null || mode == null || mode.bounds.centerX() <= speed.bounds.centerX()) {
                continue
            }

            val transport = row
                .filter { it.bounds.centerX() > speed.bounds.centerX() && it.bounds.centerX() < mode.bounds.centerX() }
                .filter { !looksLikeNonTransportControl(it.subtreeLabel) }
                .maxByOrNull { it.bounds.width() * it.bounds.height() }

            if (transport != null) {
                return transport.copy(
                    label = "Songsterr transport control between speed and sound mode",
                    score = 3,
                    tapOnly = true
                )
            }
        }

        return null
    }

    private fun collectToolbarCandidates(
        node: AccessibilityNodeInfo?,
        candidates: MutableList<TransportCandidate>
    ) {
        if (node == null) {
            return
        }

        if (node.packageName?.toString() == SONGSTERR_PACKAGE && node.isVisibleToUser && node.isClickable) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val screenHeight = resources.displayMetrics.heightPixels
            val likelyToolbarSized =
                bounds.centerY() > screenHeight * 0.60 &&
                    bounds.bottom < screenHeight - 20 &&
                    bounds.width() in 80..240 &&
                    bounds.height() in 50..190

            if (likelyToolbarSized) {
                val label = nodeLabel(node)
                candidates.add(
                    TransportCandidate(
                        node = node,
                        label = label.ifBlank { "Songsterr toolbar control" },
                        bounds = bounds,
                        score = 2,
                        tapOnly = true,
                        subtreeLabel = subtreeLabel(node)
                    )
                )
            }
        }

        for (index in 0 until node.childCount) {
            collectToolbarCandidates(node.getChild(index), candidates)
        }
    }

    private fun collectGeometryCandidates(
        node: AccessibilityNodeInfo?,
        candidates: MutableList<TransportCandidate>
    ) {
        if (node == null) {
            return
        }

        if (node.packageName?.toString() == SONGSTERR_PACKAGE && node.isVisibleToUser) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val screenHeight = resources.displayMetrics.heightPixels
            val width = bounds.width()
            val height = bounds.height()
            val subtreeLabel = subtreeLabel(node)
            val plausibleBottomControl =
                bounds.centerY() > screenHeight * 0.72 &&
                    bounds.bottom < screenHeight - 50 &&
                    width in 90..190 &&
                    height in 60..170 &&
                    (node.isClickable || clickableSelfOrAncestor(node) != null) &&
                    !looksLikeNonTransportControl(subtreeLabel)

            if (plausibleBottomControl) {
                val label = nodeLabel(node)
                candidates.add(
                    TransportCandidate(
                        node = node,
                        label = label.ifBlank { "Songsterr bottom transport button" },
                        bounds = bounds,
                        score = 1,
                        tapOnly = true,
                        subtreeLabel = subtreeLabel
                    )
                )
            }
        }

        for (index in 0 until node.childCount) {
            collectGeometryCandidates(node.getChild(index), candidates)
        }
    }

    private fun clickableSelfOrAncestor(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var current = node
        repeat(6) {
            if (current == null) {
                return null
            }
            if (current?.isClickable == true) {
                return current
            }
            current = current?.parent
        }
        return null
    }

    private fun nodeLabel(node: AccessibilityNodeInfo): String {
        return listOfNotNull(
            node.contentDescription?.toString(),
            node.text?.toString(),
            node.viewIdResourceName,
            node.className?.toString()
        )
            .joinToString(" ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    private fun subtreeLabel(node: AccessibilityNodeInfo?): String {
        if (node == null) {
            return ""
        }

        val labels = mutableListOf(nodeLabel(node))
        for (index in 0 until node.childCount) {
            labels.add(subtreeLabel(node.getChild(index)))
        }
        return labels
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    private fun looksLikeNonTransportControl(label: String): Boolean {
        if (label.isBlank()) {
            return false
        }

        val lower = label.lowercase()
        return lower.contains("bpm") ||
            lower.contains("orig") ||
            lower.contains("synth") ||
            Regex("\\d+%").containsMatchIn(lower) ||
            lower.contains("+|-")
    }

    private fun looksLikeSpeedControl(label: String): Boolean {
        return Regex("\\d+%").containsMatchIn(label.lowercase())
    }

    private fun looksLikeModeControl(label: String): Boolean {
        val lower = label.lowercase()
        return lower.contains("orig") || lower.contains("synth")
    }

    private fun isSpeedSettingsOpen(root: AccessibilityNodeInfo): Boolean {
        val lower = subtreeLabel(root).lowercase()
        val visiblePercentOptions = Regex("\\d+%").findAll(lower).take(4).count()
        return lower.contains("wiedergabegeschwindigkeit") ||
            lower.contains("playback speed") ||
            (lower.contains("bpm") && visiblePercentOptions >= 3)
    }

    private fun tapCenterOf(bounds: Rect): Boolean {
        val point = PointF(bounds.centerX().toFloat(), bounds.centerY().toFloat())
        val path = Path().apply { moveTo(point.x, point.y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    private fun dragToStart(bounds: Rect): Boolean {
        if (bounds.width() <= 1 || bounds.height() <= 1) {
            return false
        }

        val y = bounds.centerY().toFloat()
        val startX = (bounds.right - 8).toFloat()
        val endX = (bounds.left + 8).toFloat()
        val path = Path().apply {
            moveTo(startX, y)
            lineTo(endX, y)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 250))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    private fun actionLabel(action: String): String = if (action == "play") "play" else "pause"

    private data class TransportCandidate(
        val node: AccessibilityNodeInfo,
        val label: String,
        val bounds: Rect,
        val score: Int,
        val tapOnly: Boolean = false,
        val subtreeLabel: String = ""
    )

    private data class ProgressCandidate(
        val node: AccessibilityNodeInfo,
        val bounds: Rect,
        val score: Int
    )

    companion object {
        private const val SONGSTERR_PACKAGE = "com.songsterr"
        private const val TOOLBAR_ROW_BUCKET_PX = 180
        private const val ACTION_SET_PROGRESS = 0x00200000
        private val IGNORED_CONTROL_WORDS = listOf(
            "playlist",
            "playlists",
            "upgrade",
            "sign",
            "login",
            "settings",
            "search",
            "favorite",
            "print",
            "loop",
            "speed",
            "tuner"
        )

        @Volatile private var activeService: BandCueAccessibilityService? = null

        fun isEnabled(): Boolean = activeService != null

        fun foregroundPackageName(): String? {
            return try {
                activeService?.rootInActiveWindow?.packageName?.toString()
            } catch (_: Throwable) {
                null
            }
        }

        fun control(action: String, resetBeforePlay: Boolean = false): AccessibilityControlResult {
            val service = activeService
                ?: return AccessibilityControlResult(
                    ok = false,
                    detail = "Enable BandCue Songsterr in Android Accessibility settings."
                )
            return service.controlSongsterr(action, resetBeforePlay)
        }
    }
}
