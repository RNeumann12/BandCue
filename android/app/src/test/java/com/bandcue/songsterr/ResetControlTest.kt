package com.bandcue.songsterr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResetControlTest {
    @Test
    fun selectsRightmostResetInPhonePortraitLayout() {
        val play = UiRect(560, 1750, 700, 1880)
        val reset = UiRect(930, 1540, 1040, 1640)

        val selection = selectResetControl(
            screenWidth = 1080,
            screenHeight = 2200,
            playBounds = play,
            controls = listOf(
                ResetControlCandidate(UiRect(80, 1540, 190, 1640), "80%"),
                ResetControlCandidate(UiRect(350, 1540, 460, 1640), ""),
                ResetControlCandidate(UiRect(630, 1540, 740, 1640), "synth"),
                ResetControlCandidate(reset, "")
            )
        )

        assertEquals(reset, (selection as ResetControlSelection.Found).bounds)
    }

    @Test
    fun selectsResetWhenToolbarIsHigherInLargeWindowLayout() {
        val play = UiRect(1260, 1320, 1410, 1460)
        val reset = UiRect(2120, 1000, 2250, 1120)

        val selection = selectResetControl(
            screenWidth = 2400,
            screenHeight = 1800,
            playBounds = play,
            controls = listOf(
                ResetControlCandidate(UiRect(420, 1000, 560, 1120), "90%"),
                ResetControlCandidate(UiRect(980, 1000, 1120, 1120), ""),
                ResetControlCandidate(UiRect(1540, 1000, 1680, 1120), "orig"),
                ResetControlCandidate(reset, "")
            )
        )

        assertEquals(reset, (selection as ResetControlSelection.Found).bounds)
    }

    @Test
    fun cachedGeometryCanConfirmSparseShiftedLayout() {
        val play = UiRect(1100, 1220, 1240, 1350)
        val reset = UiRect(1800, 1040, 1910, 1140)
        val signature = resetLayoutSignature(2100, 1500, play)

        val selection = selectResetControl(
            screenWidth = 2100,
            screenHeight = 1500,
            playBounds = play,
            controls = listOf(
                ResetControlCandidate(UiRect(620, 1040, 730, 1140), ""),
                ResetControlCandidate(reset, "")
            ),
            cached = CachedResetControl(signature, UiRect(1790, 1035, 1900, 1135))
        )

        assertEquals(reset, (selection as ResetControlSelection.Found).bounds)
    }

    @Test
    fun reportsMissingWhenNoControlsAreAbovePlay() {
        val selection = selectResetControl(
            screenWidth = 1080,
            screenHeight = 2200,
            playBounds = UiRect(560, 1750, 700, 1880),
            controls = listOf(
                ResetControlCandidate(UiRect(560, 1900, 700, 2020), "")
            )
        )

        assertTrue(selection is ResetControlSelection.Missing)
    }

    @Test
    fun skipsLowConfidenceSingleUncachedControl() {
        val selection = selectResetControl(
            screenWidth = 1080,
            screenHeight = 2200,
            playBounds = UiRect(560, 1750, 700, 1880),
            controls = listOf(
                ResetControlCandidate(UiRect(880, 1580, 980, 1660), "")
            )
        )

        assertTrue(selection is ResetControlSelection.SkippedLowConfidence)
    }
}
