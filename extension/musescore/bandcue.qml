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
import MuseScore 3.0

MuseScore {
  id: root

  title: "BandCue Bridge"
  description: "Starts and stops playback on BandCue's downbeat, from the top of the score."
  version: "1.0"
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

  // How far ahead of the downbeat to prepare the selection, so only the play
  // command itself is left for the beat.
  readonly property int prepareLeadMs: 250

  onRun: {
    root.connect()
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
    var payload = { type: "status", ready: true, title: title }
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
      return
    }

    if (message.type === "command") {
      root.onCommand(message)
    }
  }

  function onCommand(message) {
    root.pendingSequenceId = message.sequenceId
    root.pendingAction = message.action
    root.pendingReset = message.resetBeforePlay === true
    root.pendingDueLocalAt = message.dueLocalAt

    // Claim it so the adapter does not also fire its keyboard fallback.
    root.send({ type: "claim", sequenceId: message.sequenceId, controlPath: "musescore-plugin" })

    var remainingMs = message.dueLocalAt - Date.now()
    root.lastCommandLine = message.action + " in " + Math.round(remainingMs) + " ms"

    if (message.action !== "play") {
      // Stop has no downbeat to hit.
      root.execute()
      return
    }

    // Put the selection on the first note now, during the count-in, so the beat
    // itself only has to start playback.
    if (root.pendingReset) {
      root.selectScoreStart()
    }

    var waitMs = remainingMs
    if (waitMs <= 0) {
      root.execute()
      return
    }
    downbeatTimer.interval = waitMs
    downbeatTimer.restart()
  }

  /**
   * Moves the selection to the score's first note or rest.
   *
   * This is the whole reason the plugin exists. `Cursor.rewind(0)` seeks to the
   * start of the score and `cursor.element` is then the first chord or rest --
   * a real note, not the title frame that "first-element" would land on.
   */
  function selectScoreStart() {
    try {
      if (!curScore) {
        return false
      }
      var cursor = curScore.newCursor()
      cursor.rewind(0)
      var element = cursor.element
      if (!element) {
        root.log("no element at the start of the score")
        return false
      }
      curScore.selection.select(element)
      return true
    } catch (error) {
      root.log("could not select the start of the score: " + error)
      return false
    }
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
      } else {
        cmd("stop")
        playback = "stopped"
      }
    } catch (error) {
      ok = false
      root.log("command failed: " + error)
    }

    root.lastCommandLine = root.pendingAction + (ok ? " fired" : " failed")
    root.send({
      type: "result",
      sequenceId: sequenceId,
      status: ok ? "succeeded" : "failed",
      playback: playback,
      controlPath: "musescore-plugin",
      detail: ok
        ? (root.pendingReset ? "played from the start of the score" : "played from the playback position")
        : "the plugin could not run the command"
    })
    root.sendStatus(playback)
  }

  Timer {
    id: downbeatTimer
    repeat: false
    onTriggered: root.execute()
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
