/*
 * BandCue bridge plugin for MuseScore Studio 4.
 *
 * Why this exists: driving MuseScore with simulated keystrokes cannot reset the
 * playhead. `Ctrl+Home` ("first-element") moves the cursor and the view but not
 * the playback position, MuseScore's `rewind` action does nothing while playback
 * is stopped, and `Shift+Space` ("play-from-selection") only starts at the top if
 * the cursor happens to be sitting on a note there. From inside a plugin the
 * cursor API can put the selection on the score's first real note, which is the
 * one thing keystrokes could not reliably do -- so playback genuinely starts at
 * bar 1, every time.
 *
 * It also removes the count-in BandCue had to reserve for keyboard control: the
 * adapter reports `requiredLeadMs: 0` while a bridge is attached, because there is
 * no window to foreground and no shell to launch.
 *
 * Transport is a WebSocket to the adapter's --bridge-port. MuseScore's plugin
 * sandbox has no HTTP client, but it does expose `api.websocket`, and a pushed
 * command beats polling anyway: the plugin gets the downbeat as soon as it is
 * scheduled and does its own waiting.
 *
 * Install: copy this folder into MuseScore's Plugins directory, then enable
 * "BandCue Bridge" under Home > Plugins and leave its window open while playing.
 */

import QtQuick 2.9
import QtQuick.Window 2.3
import MuseScore 3.0
import MuseScore.Playback

MuseScore {
  id: root

  title: "BandCue Bridge"
  description: "Starts and stops playback on BandCue's downbeat, from the top of the score."
  version: "1.2"
  // A dialog stays open, which is what makes the plugin resident: a plain plugin
  // finishes after onRun and could not wait for a cue.
  pluginType: "dialog"
  requiresScore: false
  implicitWidth: 320
  implicitHeight: 148

  property int bridgePort: 4731
  property int socketId: -1
  property bool connected: false
  property string statusLine: "Not connected"
  property string lastCommandLine: ""

  // The downbeat currently waiting to fire, in this machine's clock. The adapter
  // and MuseScore run on the same machine, so its dueLocalAt needs no conversion.
  property int pendingSequenceId: -1
  property string pendingAction: ""
  property bool pendingReset: false
  property double pendingDueLocalAt: 0
  // Where this play should start, 1-based. 0 means the top of the score.
  property int pendingStartMeasure: 0
  // Where the selection actually landed, so the host can warn when a score is
  // too short for the song's start measure instead of quietly playing bar 1.
  property int pendingReachedMeasure: 0
  property int requestedTempoPercent: 100
  property int appliedTempoPercent: 100
  property string tempoState: "applied"
  property string tempoDetail: "100% tempo"
  property int minimizeAttempts: 0
  property int minimizeConfirmations: 0

  PlaybackToolBarModel {
    id: playbackModel
  }

  // How far ahead of the downbeat to prepare the selection, so only the play
  // command itself is left for the beat.
  readonly property int prepareLeadMs: 250

  onRun: {
    // Ordered so one failure cannot take the others down with it. Loading the
    // playback model is the only step that touches a MuseScore internal model,
    // and a build where that type moved must still get cues and still get out
    // of the way of the score.
    try {
      playbackModel.load()
    } catch (error) {
      root.tempoState = "unsupported"
      root.tempoDetail = "MuseScore Bridge could not load the playback model: " + error
      root.log("playback model unavailable: " + error)
    }
    root.connect()
    root.minimizeAttempts = 0
    root.minimizeConfirmations = 0
    minimizeTimer.restart()
  }

  function log(message) {
    console.log("[BandCue] " + message)
  }

  function connect() {
    root.statusLine = "Connecting to 127.0.0.1:" + root.bridgePort + "..."
    // The client API takes a port, not a URL, and connects to localhost -- which
    // is why the adapter accepts the upgrade on any path.
    api.websocket.open(root.bridgePort, function(id) {
      root.socketId = id
      root.connected = true
      root.statusLine = "Connected to BandCue"
      root.log("connected, socket " + id)
      api.websocket.onMessage(root.socketId, root.onBridgeMessage)
      root.sendStatus("stopped")
    })
  }

  function send(payload) {
    if (root.socketId < 0) {
      return
    }
    api.websocket.send(root.socketId, JSON.stringify(payload))
  }

  function sendStatus(playback) {
    var title = ""
    try {
      if (curScore) {
        title = curScore.scoreName ? curScore.scoreName : ""
      }
    } catch (error) {
      title = ""
    }
    var payload = {
      type: "status",
      ready: true,
      title: title,
      tempo: {
        requestedPercent: root.requestedTempoPercent,
        appliedPercent: root.tempoState === "applied" ? root.appliedTempoPercent : undefined,
        state: root.tempoState,
        detail: root.tempoDetail
      }
    }
    // Omitted rather than guessed when unknown: the adapter keeps the last known
    // playback state instead of being told something wrong.
    if (playback !== undefined) {
      payload.playback = playback
    }
    root.send(payload)
  }

  function onBridgeMessage(raw) {
    var message
    try {
      message = JSON.parse(raw)
    } catch (error) {
      root.log("ignoring unparseable message")
      return
    }

    if (message.type === "hello") {
      root.statusLine = "Connected to BandCue"
      root.applyTempo(message.currentSong)
      return
    }

    if (message.type === "song") {
      root.applyTempo(message.currentSong)
      return
    }

    if (message.type === "retire") {
      root.connected = false
      root.statusLine = "Switching to the next score..."
      root.log("retiring bridge before score change")
      Qt.quit()
      return
    }

    if (message.type === "command") {
      root.onCommand(message)
    }
  }

  function onCommand(message) {
    root.applyTempo(message.currentSong)

    if (message.action === "open-song") {
      root.lastCommandLine = "opening song through BandCue helper"
      root.send({
        type: "result",
        sequenceId: message.sequenceId,
        status: "failed",
        controlPath: "musescore-plugin-delegated",
        detail: "The Windows helper will open the score and restart BandCue Bridge in its MuseScore process"
      })
      return
    }

    root.pendingSequenceId = message.sequenceId
    root.pendingAction = message.action
    root.pendingReset = message.resetBeforePlay === true
    root.pendingDueLocalAt = message.dueLocalAt
    // The adapter's sanitized value wins; currentSong is the fallback for an
    // older adapter that does not put startMeasure on the socket payload.
    root.pendingStartMeasure = root.requestedStartMeasure(message)
    root.pendingReachedMeasure = 0

    // Claim it so the adapter does not also fire its keyboard fallback.
    root.send({ type: "claim", sequenceId: message.sequenceId, controlPath: "musescore-plugin" })

    if (message.action === "play" && root.tempoState !== "applied") {
      root.send({
        type: "result",
        sequenceId: message.sequenceId,
        status: "failed",
        playback: "stopped",
        controlPath: "musescore-plugin-tempo",
        detail: root.tempoDetail
      })
      root.lastCommandLine = "play blocked: " + root.tempoDetail
      return
    }

    var remainingMs = message.dueLocalAt - Date.now()
    root.lastCommandLine = message.action + " in " + Math.round(remainingMs) + " ms"

    if (message.action !== "play") {
      // Stop has no downbeat to hit.
      root.execute()
      return
    }

    // Put the selection on the starting note now, during the count-in, so the
    // beat itself only has to start playback.
    if (root.pendingReset) {
      root.pendingReachedMeasure = root.selectStartPoint(root.pendingStartMeasure)
    }

    var waitMs = remainingMs
    if (waitMs <= 0) {
      root.execute()
      return
    }
    downbeatTimer.interval = waitMs
    downbeatTimer.restart()
  }

  // A dialog plugin must remain open to receive cues, but it should not cover
  // the score.
  //
  // `Window.window` is attached to the *item*, and MuseScore only puts the
  // plugin item into its dialog after onRun -- so this returns null for the
  // first few ticks no matter which build is running. root.parent is tried as
  // well because MuseScore has wrapped the plugin item differently across 4.x.
  function bridgeWindow() {
    try {
      if (root.Window.window) {
        return root.Window.window
      }
    } catch (error) {
      // Attached property unavailable on this build; the parent lookup may work.
    }
    try {
      if (root.parent && root.parent.Window.window) {
        return root.parent.Window.window
      }
    } catch (error) {
      root.log("bridge window not reachable yet: " + error)
    }
    return null
  }

  function applyTempo(song) {
    var requested = song && song.tempoPercent !== undefined ? Math.round(song.tempoPercent) : 100
    requested = Math.max(15, Math.min(175, requested))
    root.requestedTempoPercent = requested
    root.tempoState = "pending"
    root.tempoDetail = "Applying " + requested + "% tempo"
    try {
      playbackModel.tempoMultiplier = requested / 100.0
      var applied = Math.round(playbackModel.tempoMultiplier * 100)
      root.appliedTempoPercent = applied
      root.tempoState = applied === requested ? "applied" : "failed"
      root.tempoDetail = applied === requested
        ? requested + "% tempo applied through MuseScore Bridge"
        : "MuseScore reported " + applied + "% after requesting " + requested + "%"
    } catch (error) {
      root.tempoState = "failed"
      root.tempoDetail = "MuseScore Bridge could not set tempo: " + error
    }
    root.sendStatus(undefined)
  }

  /** The start measure the adapter asked for, or 0 for the top of the score. */
  function requestedStartMeasure(message) {
    if (typeof message.startMeasure === "number" && message.startMeasure > 1) {
      return Math.round(message.startMeasure)
    }
    if (message.currentSong && typeof message.currentSong.startMeasure === "number"
        && message.currentSong.startMeasure > 1) {
      return Math.round(message.currentSong.startMeasure)
    }
    return 0
  }

  /**
   * Moves the selection to the first note or rest of `measureNumber` (1-based),
   * or of the score when it is 0. Returns the measure actually reached, or 0 if
   * nothing could be selected.
   *
   * This is the whole reason the plugin exists. `Cursor.rewind(0)` seeks to the
   * start of the score and `cursor.element` is then the first chord or rest --
   * a real note, not the title frame that "first-element" would land on.
   * `rewindToTick` extends that to any measure, which is what keystrokes could
   * only do by typing into MuseScore's Find box with the window in front.
   */
  function selectStartPoint(measureNumber) {
    try {
      if (!curScore) {
        return 0
      }
      var cursor = curScore.newCursor()
      cursor.rewind(0)
      var reached = 1

      if (measureNumber > 1) {
        // Walk the measure chain rather than calling nextMeasure() in a loop:
        // the chain is a plain property in every 3.x/4.x plugin API, so this
        // does not depend on a Cursor method whose return value has changed.
        var measure = curScore.firstMeasure
        while (measure && reached < measureNumber && measure.nextMeasure) {
          measure = measure.nextMeasure
          reached += 1
        }
        if (!measure) {
          root.log("score has no measures")
          return 0
        }
        // Short score: land on the last measure and say so, rather than
        // pretending the requested one was reached.
        if (reached < measureNumber) {
          root.log("score ends at measure " + reached + "; measure " + measureNumber + " was requested")
        }
        cursor.rewindToTick(measure.firstSegment.tick)
      }

      var element = root.elementAtCursor(cursor)
      if (!element) {
        root.log("no note or rest at measure " + reached)
        return 0
      }
      curScore.selection.select(element)
      return reached
    } catch (error) {
      root.log("could not select the start point: " + error)
      return 0
    }
  }

  /**
   * The chord or rest under the cursor. Voice 1 of the top staff is empty often
   * enough (a score that starts on a pickup in another voice, a part that rests
   * through the intro) that falling back across the staves beats reporting that
   * the measure could not be played.
   */
  function elementAtCursor(cursor) {
    if (cursor.element) {
      return cursor.element
    }
    var trackCount = curScore.ntracks
    for (var track = 1; track < trackCount; track++) {
      cursor.track = track
      if (cursor.element) {
        return cursor.element
      }
    }
    return null
  }

  /** What this play actually did, in the words the host shows the band. */
  function playDetail() {
    if (root.pendingAction !== "play") {
      return "stopped playback"
    }
    if (!root.pendingReset) {
      return "played from the playback position"
    }
    if (root.pendingStartMeasure > 1 && root.pendingReachedMeasure === root.pendingStartMeasure) {
      return "played from measure " + root.pendingReachedMeasure
    }
    if (root.pendingStartMeasure > 1) {
      return "could not reach measure " + root.pendingStartMeasure
        + "; played from measure " + root.pendingReachedMeasure + " instead"
    }
    return "played from the start of the score"
  }

  function execute() {
    var sequenceId = root.pendingSequenceId
    if (sequenceId < 0) {
      return
    }
    root.pendingSequenceId = -1

    var playback = "stopped"
    var ok = true
    try {
      if (root.pendingAction === "play") {
        // With the selection on the first note, this starts there rather than
        // wherever the playhead was last left.
        cmd(root.pendingReset ? "play-from-selection" : "play")
        playback = "playing"
      } else if (root.pendingAction === "stop") {
        cmd("stop")
        playback = "stopped"
      } else {
        ok = false
        root.log("unsupported command: " + root.pendingAction)
      }
    } catch (error) {
      ok = false
      root.log("command failed: " + error)
    }

    root.lastCommandLine = root.pendingAction + (ok ? " fired" : " failed")
    var result = {
      type: "result",
      sequenceId: sequenceId,
      status: ok ? "succeeded" : "failed",
      playback: playback,
      controlPath: "musescore-plugin",
      detail: ok ? root.playDetail() : "the plugin could not run the command"
    }
    // The adapter reads this back as reachedMeasure and the host warns when it
    // does not match the song, so only claim a measure the selection reached.
    if (ok && root.pendingAction === "play" && root.pendingReset && root.pendingReachedMeasure > 0) {
      result.startMeasure = root.pendingReachedMeasure
    }
    root.send(result)
    root.sendStatus(playback)
  }

  Timer {
    id: downbeatTimer
    repeat: false
    onTriggered: root.execute()
  }

  // Keeps minimizing until the window *stays* minimized. One showMinimized() is
  // not enough: MuseScore raises the dialog as part of showing it, so a single
  // early call can be undone a tick later and the score stays covered. Stops
  // after three consecutive minimized ticks, or gives up after 10 s so a build
  // that never exposes the window does not spin all night.
  Timer {
    id: minimizeTimer
    interval: 250
    repeat: true
    onTriggered: {
      var pluginWindow = root.bridgeWindow()
      if (pluginWindow) {
        if (pluginWindow.visibility === Window.Minimized) {
          root.minimizeConfirmations += 1
        } else {
          root.minimizeConfirmations = 0
          pluginWindow.showMinimized()
        }
      }
      root.minimizeAttempts += 1
      if (root.minimizeConfirmations >= 3 || root.minimizeAttempts >= 40) {
        minimizeTimer.stop()
      }
    }
  }

  // Keeps the adapter's "a bridge is attached" window open (it expires after 5 s)
  // and keeps the host's view of playback state fresh.
  Timer {
    id: heartbeatTimer
    interval: 2000
    repeat: true
    running: root.connected
    onTriggered: root.sendStatus(undefined)
  }

  Rectangle {
    anchors.fill: parent
    color: "transparent"

    Column {
      anchors.centerIn: parent
      spacing: 8

      Text {
        text: "BandCue Bridge"
        font.bold: true
      }
      Text { text: root.statusLine }
      Text {
        text: root.lastCommandLine
        visible: root.lastCommandLine !== ""
      }
      Text {
        text: "Keep this window open while playing."
        font.pixelSize: 11
      }
    }
  }
}
