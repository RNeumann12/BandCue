package com.bandcue.songsterr

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class UiRect(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int
) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
}

data class ResetControlCandidate(
    val bounds: UiRect,
    val label: String = ""
)

data class ResetLayoutSignature(
    val screenWidth: Int,
    val screenHeight: Int,
    val playCenterX: Int,
    val playCenterY: Int
)

data class CachedResetControl(
    val signature: ResetLayoutSignature,
    val bounds: UiRect
)

sealed class ResetControlSelection {
    data class Found(
        val bounds: UiRect,
        val detail: String
    ) : ResetControlSelection()

    data class SkippedLowConfidence(
        val detail: String
    ) : ResetControlSelection()

    data class Missing(
        val detail: String
    ) : ResetControlSelection()
}

fun resetLayoutSignature(screenWidth: Int, screenHeight: Int, playBounds: UiRect): ResetLayoutSignature {
    return ResetLayoutSignature(
        screenWidth = screenWidth,
        screenHeight = screenHeight,
        playCenterX = playBounds.centerX,
        playCenterY = playBounds.centerY
    )
}

fun isPlausibleSongsterrToolbarControl(bounds: UiRect, screenWidth: Int, screenHeight: Int): Boolean {
    if (bounds.width <= 0 || bounds.height <= 0) {
        return false
    }

    val maxControlWidth = max(180, (screenWidth * 0.32).toInt())
    val maxControlHeight = max(150, (screenHeight * 0.20).toInt())
    return bounds.centerY > screenHeight * 0.28 &&
        bounds.bottom < screenHeight - 8 &&
        bounds.width in 48..maxControlWidth &&
        bounds.height in 36..maxControlHeight
}

fun selectResetControl(
    screenWidth: Int,
    screenHeight: Int,
    playBounds: UiRect,
    controls: List<ResetControlCandidate>,
    cached: CachedResetControl? = null
): ResetControlSelection {
    val signature = resetLayoutSignature(screenWidth, screenHeight, playBounds)
    val rowTolerance = max(56, min(180, playBounds.height))
    val minGap = max(36, (playBounds.height * 0.35).toInt())
    val maxGap = max(220, (screenHeight * 0.45).toInt())
    val usable = controls
        .filter { isPlausibleSongsterrToolbarControl(it.bounds, screenWidth, screenHeight) }
        .filter { it.bounds.centerY < playBounds.centerY - minGap }
        .filter { playBounds.centerY - it.bounds.centerY <= maxGap }

    if (usable.isEmpty()) {
        return ResetControlSelection.Missing(
            "Reset-to-start button was missing: no visible Songsterr toolbar controls were found above play."
        )
    }

    val rows = clusterRows(usable, rowTolerance)
    val scoredRows = rows.mapNotNull { row ->
        val sorted = row.sortedBy { it.bounds.centerX }
        val reset = sorted.maxByOrNull { it.bounds.centerX } ?: return@mapNotNull null
        val score = scoreResetRow(
            row = sorted,
            reset = reset,
            screenWidth = screenWidth,
            playBounds = playBounds,
            signature = signature,
            cached = cached
        )
        ScoredResetRow(reset, sorted, score)
    }

    val best = scoredRows.maxWithOrNull(
        compareBy<ScoredResetRow> { it.score }
            .thenBy { abs(it.reset.bounds.centerY - (playBounds.centerY - 160)) * -1 }
            .thenBy { it.reset.bounds.centerX }
    ) ?: return ResetControlSelection.Missing(
        "Reset-to-start button was missing: no reset row could be inferred above play."
    )

    return if (best.score >= RESET_CONFIDENCE_THRESHOLD) {
        ResetControlSelection.Found(
            bounds = best.reset.bounds,
            detail = "Reset-to-start candidate selected from ${best.row.size} controls above play."
        )
    } else {
        ResetControlSelection.SkippedLowConfidence(
            "Reset-to-start was skipped: visible controls above play did not form a confident reset row."
        )
    }
}

private fun clusterRows(
    controls: List<ResetControlCandidate>,
    rowTolerance: Int
): List<List<ResetControlCandidate>> {
    val rows = mutableListOf<MutableList<ResetControlCandidate>>()
    for (control in controls.sortedBy { it.bounds.centerY }) {
        val row = rows.firstOrNull {
            abs(it.map { candidate -> candidate.bounds.centerY }.average() - control.bounds.centerY) <= rowTolerance
        }
        if (row == null) {
            rows.add(mutableListOf(control))
        } else {
            row.add(control)
        }
    }
    return rows
}

private fun scoreResetRow(
    row: List<ResetControlCandidate>,
    reset: ResetControlCandidate,
    screenWidth: Int,
    playBounds: UiRect,
    signature: ResetLayoutSignature,
    cached: CachedResetControl?
): Int {
    val rowSpan = (row.maxOf { it.bounds.right } - row.minOf { it.bounds.left }).coerceAtLeast(0)
    val gap = playBounds.centerY - row.map { it.bounds.centerY }.average()
    val resetLabel = reset.label.lowercase()
    var score = 0

    if (row.size >= 2) score += 1
    if (row.size >= 3) score += 2
    if (rowSpan >= playBounds.width * 2) score += 2
    if (reset.bounds.centerX > playBounds.centerX + playBounds.width * 0.35) score += 2
    if (reset.bounds.centerX > screenWidth * 0.55) score += 1
    if (gap in 56.0..320.0) score += 2
    if (row.any { looksLikeSpeedLabel(it.label) }) score += 1
    if (row.any { looksLikeModeLabel(it.label) }) score += 1
    if (looksLikeNonResetLabel(resetLabel)) score -= 4
    if (cached != null && cached.signature == signature && centersAreClose(reset.bounds, cached.bounds)) score += 6

    return score
}

private fun centersAreClose(first: UiRect, second: UiRect): Boolean {
    return abs(first.centerX - second.centerX) <= max(48, second.width / 2) &&
        abs(first.centerY - second.centerY) <= max(48, second.height / 2)
}

private fun looksLikeSpeedLabel(label: String): Boolean {
    return Regex("\\d+%").containsMatchIn(label.lowercase())
}

private fun looksLikeModeLabel(label: String): Boolean {
    val lower = label.lowercase()
    return lower.contains("orig") || lower.contains("synth")
}

private fun looksLikeNonResetLabel(label: String): Boolean {
    return label.contains("bpm") ||
        label.contains("orig") ||
        label.contains("synth") ||
        label.contains("play") ||
        Regex("\\d+%").containsMatchIn(label)
}

private data class ScoredResetRow(
    val reset: ResetControlCandidate,
    val row: List<ResetControlCandidate>,
    val score: Int
)

private const val RESET_CONFIDENCE_THRESHOLD = 6
