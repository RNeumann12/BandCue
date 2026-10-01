/*
 * BandCue bridge plugin for MuseScore Studio 4.
 *
 * Why this exists: driving MuseScore with simulated keystrokes cannot reset the
 * playhead. `Ctrl+Home` ("first-element") moves the cursor and the view but not
 * the playback position, MuseScore's `rewind` action does nothing while playback
 * is stopped, and `Shift+Space` ("play-from-selection") only starts at the top if
 * the cursor happens to be sitting on a note there. From inside a plugin the
 * playback toolbar's own position fields can be set (see seekPlayback), which is
 * the one thing keystrokes could not reliably do -- so playback genuinely starts
 * at bar 1, or at the song's start measure, every time.
 *
 * It also removes the count-in BandCue had to reserve for keyboard control: the
 * adapter reports `requiredLeadMs: 0` while a bridge is attached, because there is
 * no window to foreground and no shell to launch.
 *
 * Resident, and it changes songs itself. This is deliberately *not* a dialog
 * plugin: MuseScore runs a dialog plugin as a window, and closing a score closes
 * every open dialog, so a dialog bridge could never survive a song change -- the
 * adapter had to launch a whole new MuseScore for every song and then start the
 * plugin again by typing into the Plugins menu. A plugin without a window stays
 * loaded for the life of the MuseScore process, so on a song change it closes the
 * current score and opens the next one with `closeScore()` / `readScore()` in the
 * same window, which takes a second or two instead of a relaunch.
 *
 * Transport is a WebSocket to the adapter's --bridge-port. MuseScore's plugin
 * sandbox has no HTTP client, but it does expose `api.websocket`, and a pushed
 * command beats polling anyway: the plugin gets the downbeat as soon as it is
 * scheduled and does its own waiting. That client API reports nothing when the
 * connection drops, so the adapter sends a `ping` every second and the plugin
 * reconnects when they stop -- which is what lets the adapter be restarted
 * without restarting MuseScore.
 *
 * Install: the MuseScore adapter copies this file into MuseScore's Plugins folder
 * and sets it to run automatically whenever MuseScore opens a score. Restart
 * MuseScore once after the first install so it picks the plugin up.
 */

import QtQuick 2.9
import MuseScore 3.0
import MuseScore.Playback

MuseScore {
  id: root

  title: "BandCue Bridge"
  description: "Starts and stops playback on BandCue's downbeat and opens the band's next song, without a plugin window."
  version: "2.0"
  requiresScore: false

  /** Bumped whenever the socket protocol gains something the adapter must know about. */
  readonly property int protocolVersion: 2
  property int bridgePort: 4731
  property int socketId: -1
  property bool connected: false
  /** Set once the adapter has told this copy to stand down; it never reconnects after that. */
  property bool dormant: false
  // Every run of the plugin is its own object, and MuseScore runs it again each
  // time a score opens. This tells the adapter which copy is which.
  property string instanceId: ""
  property int connectAttempt: 0
  property double connectStartedAt: 0
  property double lastInboundAt: 0

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
  // The current song's start measure (0 = top), and where the cursor is already
  // parked for it. Held between commands so the walk to the measure can happen
  // when the song is picked rather than inside the count-in.
  property int songStartMeasure: 0
  property int preparedMeasure: 0
  property var lastSong: null
  property int requestedTempoPercent: 100
  property int appliedTempoPercent: 100
  property string tempoState: "applied"
  property string tempoDetail: "100% tempo"
  // The score switch in progress, between closing the old score and opening the
  // new one on the next event-loop turn.
  property var pendingOpen: null
  // An opened score whose result waits for MuseScore to be able to play it.
  property var pendingReadyOpen: null
  readonly property int readyTimeoutMs: 20000
  // When the pending command reached the plugin, for the adapter's timing log.
  property double pendingReceivedAt: 0
  // Checking that a fired Play really started MuseScore's playback.
  property int verifySequenceId: -1
  property double verifyFiredAt: 0
  readonly property int verifyTimeoutMs: 2000
  // What the plugin last saw of playback: set once a Play's check sees the
  // position move, cleared on Stop. "play" toggles, so it must not hit a
  // running MuseScore.
  property bool playbackRunning: false
  // The playback-position seek in progress (see seekPlayback).
  property int seekTarget: 1
  property int seekPhase: 0
  property double seekDeadline: 0
  property bool seekOk: false
  readonly property int seekTimeoutMs: 1500
  // The last stretch before a downbeat that is waited out on the wall clock.
  readonly property int downbeatSpinMs: 30

  PlaybackToolBarModel {
    id: playbackModel
  }

  // How long without any message from the adapter before the link counts as
  // dead. The adapter pings every second.
  readonly property int linkTimeoutMs: 4000
  // How long a connection attempt may stay unanswered before it is retried.
  readonly property int connectTimeoutMs: 3000

  onRun: {
    root.instanceId = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
    // Ordered so one failure cannot take the others down with it. Loading the
    // playback model is the only step that touches a MuseScore internal model,
    // and a build where that type moved must still get cues.
    try {
      playbackModel.load()
    } catch (error) {
      root.tempoState = "unsupported"
      root.tempoDetail = "MuseScore Bridge could not load the playback model: " + error
      root.log("playback model unavailable: " + error)
    }
    root.connect()
  }

  function log(message) {
    console.log("[BandCue] " + message)
  }

  function connect() {
    if (root.dormant) {
      return
    }
    root.closeSocket()
    var attempt = ++root.connectAttempt
    root.connectStartedAt = Date.now()
    // The client API takes a port, not a URL, and connects to localhost -- which
    // is why the adapter accepts the upgrade on any path.
    api.websocket.open(root.bridgePort, function(id) {
      if (attempt !== root.connectAttempt || root.dormant) {
        // A slow answer to an attempt that has since been replaced.
        try { api.websocket.close(id) } catch (error) {}
        return
      }
      root.socketId = id
      root.connected = true
      root.lastInboundAt = Date.now()
      root.log("connected, socket " + id)
      api.websocket.onMessage(id, function(raw) {
        if (id === root.socketId) {
          root.onBridgeMessage(raw)
        }
      })
      root.sendStatus("stopped")
    })
  }

  function closeSocket() {
    if (root.socketId >= 0) {
      // close() is missing on older 4.x builds; the reconnect still works there,
      // it just leaves the old socket for MuseScore to clean up.
      try { api.websocket.close(root.socketId) } catch (error) {}
    }
    root.socketId = -1
    root.connected = false
  }

  function send(payload) {
    if (root.socketId < 0 || root.dormant) {
      return
    }
    api.websocket.send(root.socketId, JSON.stringify(payload))
  }

  function scoreName() {
    try {
      return curScore && curScore.scoreName ? String(curScore.scoreName) : ""
    } catch (error) {
      return ""
    }
  }

  /**
   * Whether MuseScore would start playback right now. It drops a play request
   * without a word while a score's sounds are still loading -- seconds, in a
   * freshly started MuseScore with a large score -- so "the score is open" is
   * not the same as "the band can start".
   */
  function playReady() {
    try {
      return root.scoreName() !== "" && playbackModel.isPlayAllowed === true
    } catch (error) {
      // A build without the property: assume ready, as before it existed.
      return root.scoreName() !== ""
    }
  }

  function playPosition() {
    try {
      return Number(playbackModel.playPosition)
    } catch (error) {
      return NaN
    }
  }

  function sendStatus(playback) {
    var title = root.scoreName()
    var payload = {
      type: "status",
      ready: true,
      playReady: root.playReady(),
      title: title,
      scoreName: title,
      hasScore: title !== "",
      version: root.version,
      protocol: root.protocolVersion,
      instanceId: root.instanceId,
      canOpenScores: true,
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
    root.lastInboundAt = Date.now()
    var message
    try {
      message = JSON.parse(raw)
    } catch (error) {
      root.log("ignoring unparseable message")
      return
    }

    if (message.type === "ping") {
      return
    }

    if (message.type === "hello") {
      root.lastSong = message.currentSong || null
      root.applyTempo(message.currentSong)
      // Recorded, not acted on: the `prepare` that follows is the one that knows
      // whether the room is in a state where moving the cursor is welcome.
      root.noteStartMeasure(message)
      return
    }

    if (message.type === "song") {
      root.lastSong = message.currentSong || null
      root.applyTempo(message.currentSong)
      root.noteStartMeasure(message)
      return
    }

    if (message.type === "prepare") {
      root.prepareStartPoint(message, message.reason)
      return
    }

    if (message.type === "open") {
      root.openScore(message)
      return
    }

    if (message.type === "retire") {
      // Another copy of the plugin is already serving the adapter (MuseScore
      // runs the plugin again every time a score opens), or the adapter is about
      // to replace this MuseScore. Either way this copy must stop taking cues,
      // and must not reconnect and take them back.
      root.log("retiring: " + (message.reason || "no reason given"))
      root.dormant = true
      downbeatTimer.stop()
      openTimer.stop()
      root.closeSocket()
      Qt.quit()
      return
    }

    if (message.type === "command") {
      root.onCommand(message)
    }
  }

  function onCommand(message) {
    root.pendingReceivedAt = Date.now()
    root.applyTempo(message.currentSong)

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
      root.pendingSequenceId = -1
      return
    }

    if (message.action !== "play") {
      // Stop has no downbeat to hit.
      root.execute()
      return
    }

    // Put the selection on the starting note now, during the count-in, so the
    // beat itself only has to start playback. Usually the cursor is already
    // there -- the room sends a `prepare` as soon as it knows the measure, well
    // before any count-in -- and this is a re-check; it runs anyway so a Play is
    // never at the mercy of a prepare that did not arrive, and so a click in the
    // score between arming and Play cannot move where the song starts.
    if (root.pendingReset) {
      if (root.playbackRunning) {
        // "play" toggles: on a running MuseScore it would pause instead.
        cmd("stop")
        root.playbackRunning = false
      }
      // The selection only shows the band where the song starts; the seek is
      // what playback starts from.
      root.selectStartPoint(root.pendingStartMeasure)
      root.seekPlayback(root.pendingStartMeasure > 1 ? root.pendingStartMeasure : 1)
    }

    root.waitForDownbeat()
  }

  /**
   * Fires the pending command on its downbeat, by the wall clock.
   *
   * Not with a Timer set to the remaining time: a QML Timer runs on Qt Quick's
   * animation clock, and inside MuseScore that clock ran up to twice as fast as
   * real time -- a Play due in 1.5 s fired after 0.6 s. The ticks here only
   * decide when to look at Date.now(), and the last few milliseconds are waited
   * out exactly, so the beat lands within a millisecond whatever the ticks do.
   */
  function waitForDownbeat() {
    if (root.pendingSequenceId < 0) {
      downbeatTimer.stop()
      return
    }
    var remainingMs = root.pendingDueLocalAt - Date.now()
    if (remainingMs > root.downbeatSpinMs) {
      if (!downbeatTimer.running) {
        downbeatTimer.start()
      }
      return
    }
    downbeatTimer.stop()
    while (Date.now() < root.pendingDueLocalAt) {
      // Spin: at most downbeatSpinMs, on purpose.
    }
    root.execute()
  }

  /**
   * Switches to another score in this same MuseScore window.
   *
   * MuseScore only opens a score into the current window when that window has
   * no score (otherwise it starts a new MuseScore process for it), so the
   * current one is closed first. Closing asks about unsaved changes like any
   * close does; if the answer keeps the score open, this reports that instead
   * of opening the next score somewhere else.
   *
   * The open itself runs on the next event-loop turn: closing a score takes
   * MuseScore back to its Home page, and opening from inside that same call
   * would race the page change.
   */
  function openScore(message) {
    var sequenceId = message.sequenceId
    root.send({ type: "claim", sequenceId: sequenceId, controlPath: "musescore-plugin-open" })

    var wanted = message.scoreName ? String(message.scoreName) : ""
    var current = root.scoreName()
    if (current !== "" && wanted !== "" && current === wanted) {
      root.finishOpen(message, "already open")
      return
    }

    if (current !== "") {
      try {
        closeScore()
      } catch (error) {
        root.failOpen(sequenceId, "MuseScore Bridge could not close " + current + ": " + error)
        return
      }
      if (root.scoreName() !== "") {
        root.failOpen(sequenceId, "MuseScore kept " + current + " open (unsaved changes?), so "
          + wanted + " was not opened")
        return
      }
    }

    root.pendingOpen = message
    openTimer.restart()
  }

  function readPendingScore() {
    var message = root.pendingOpen
    root.pendingOpen = null
    if (!message) {
      return
    }
    try {
      readScore(String(message.path))
    } catch (error) {
      root.failOpen(message.sequenceId, "MuseScore Bridge could not open " + message.path + ": " + error)
      return
    }
    if (root.scoreName() === "") {
      // readScore hands a score that is open in *another* MuseScore window to
      // that window, and leaves this one empty. The adapter moves the bridge
      // over to that window.
      root.failOpen(message.sequenceId, "MuseScore showed " + message.path
        + " in another MuseScore window that already had it open", "open-elsewhere")
      return
    }
    root.finishOpen(message, "opened")
  }

  function finishOpen(message, how) {
    // A new score comes up with MuseScore's own tempo and the cursor nowhere.
    root.lastSong = message.currentSong || root.lastSong
    root.applyTempo(root.lastSong)
    root.preparedMeasure = 0
    root.noteStartMeasure(message)
    root.prepareStartPoint(message, "the score was opened")
    // Done means playable: the band hears "ready" when a Play would start.
    root.pendingReadyOpen = { message: message, how: how, since: Date.now() }
    readyTimer.restart()
    root.reportOpenWhenReady()
  }

  function reportOpenWhenReady() {
    var pending = root.pendingReadyOpen
    if (!pending) {
      readyTimer.stop()
      return
    }
    var ready = root.playReady()
    var waitedMs = Date.now() - pending.since
    if (!ready && waitedMs < root.readyTimeoutMs) {
      return
    }
    readyTimer.stop()
    root.pendingReadyOpen = null
    var name = root.scoreName()
    var detail = pending.how === "already open"
      ? name + " was already open in MuseScore"
      : "Opened " + name + " in the running MuseScore window"
    if (!ready) {
      detail += ", but MuseScore is still loading its sounds"
    } else if (waitedMs >= 200) {
      detail += " (sounds ready after " + waitedMs + " ms)"
    }
    root.send({
      type: "result",
      sequenceId: pending.message.sequenceId,
      status: "succeeded",
      playback: "stopped",
      controlPath: "musescore-plugin-open",
      title: name,
      detail: detail
    })
    root.sendStatus("stopped")
  }

  function failOpen(sequenceId, detail, reason) {
    root.log(detail)
    root.send({
      type: "result",
      sequenceId: sequenceId,
      status: "failed",
      reason: reason || "",
      controlPath: "musescore-plugin-open",
      title: root.scoreName(),
      detail: detail
    })
    root.sendStatus(undefined)
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

  /**
   * Notes where the next Play starts, without touching the score.
   *
   * Kept apart from acting on it because `hello` and `song` say what the song
   * is, not whether this is a moment to move the cursor -- a song can be picked
   * while the band is still playing the previous one.
   */
  function noteStartMeasure(message) {
    var measure = root.requestedStartMeasure(message)
    if (measure === root.songStartMeasure) {
      return
    }
    root.songStartMeasure = measure
    // The cursor is wherever the last song left it, which is no longer where the
    // next Play starts.
    root.preparedMeasure = 0
  }

  /**
   * Moves the cursor to the song's start measure right away, outside any
   * count-in.
   *
   * Walking to a measure is the slowest thing this plugin does and the only part
   * of a Play that does not have to happen on the beat, so the adapter asks for
   * it as soon as the answer is known: the score opened, the song changed, the
   * host armed, playback stopped. By the downbeat the cursor is normally already
   * parked -- visibly, on screen, while there is still time to react if the jump
   * went somewhere unexpected.
   *
   * Whether the moment is safe is the *adapter's* call: it follows the room's
   * transport state, while this plugin only ever learns that playback started,
   * never that a song ended on its own. A `prepare` that arrives is one the room
   * says nothing is playing for.
   */
  function prepareStartPoint(message, reason) {
    root.noteStartMeasure(message)
    var wanted = root.songStartMeasure > 1 ? root.songStartMeasure : 1
    if (root.preparedMeasure === wanted) {
      return
    }

    root.preparedMeasure = root.selectStartPoint(root.songStartMeasure)
    root.seekPlayback(wanted)
    root.log("cursor at measure " + root.preparedMeasure + " (" + reason + ")")
  }

  /**
   * Moves MuseScore's playback position to the start of `measure` (1-based),
   * through the playback toolbar's own position fields -- the measure box a
   * user types into.
   *
   * This, not the selection, is what decides where a Play starts. A selection
   * made by a plugin does not reliably reach MuseScore's playback: measured on
   * 4.7.2, "play-from-selection" silently did nothing on a score MuseScore had
   * opened at launch, and again on repeat plays. A plain "play" from a position
   * set here started every time.
   *
   * MuseScore seeks asynchronously and its setters read the current position
   * back, so this goes one step at a time -- the top first, then the measure,
   * then its first beat -- each once the toolbar reports the previous one.
   */
  function seekPlayback(measure) {
    root.seekTarget = Math.max(1, measure)
    root.seekOk = false
    root.seekDeadline = Date.now() + root.seekTimeoutMs
    try {
      root.seekPhase = 1
      playbackModel.playPosition = 0
    } catch (error) {
      root.seekPhase = 0
      root.log("could not move the playback position: " + error)
      return
    }
    seekTimer.start()
    root.stepSeek()
  }

  function stepSeek() {
    if (root.seekPhase === 0) {
      seekTimer.stop()
      return
    }
    var measure
    var beat
    var position
    try {
      measure = playbackModel.measureNumber
      beat = playbackModel.beatNumber
      position = Number(playbackModel.playPosition)
    } catch (error) {
      root.finishSeek(false)
      return
    }
    if (Date.now() > root.seekDeadline) {
      root.finishSeek(measure === root.seekTarget && beat === 1)
      return
    }
    if (root.seekPhase === 1) {
      if (position !== 0) {
        return
      }
      if (root.seekTarget === 1) {
        root.finishSeek(true)
        return
      }
      root.seekPhase = 2
      playbackModel.measureNumber = root.seekTarget
      return
    }
    if (measure !== root.seekTarget) {
      return
    }
    if (beat !== 1 && root.seekPhase === 2) {
      root.seekPhase = 3
      playbackModel.beatNumber = 1
      return
    }
    if (beat === 1) {
      root.finishSeek(true)
    }
  }

  function finishSeek(ok) {
    root.seekPhase = 0
    root.seekOk = ok
    seekTimer.stop()
    if (!ok) {
      var where = ""
      try {
        where = " (it is at measure " + playbackModel.measureNumber + ", beat " + playbackModel.beatNumber + ")"
      } catch (error) {
        where = ""
      }
      root.log("could not move the playback position to measure " + root.seekTarget + where)
    }
  }

  /** The measure MuseScore's playback would start from, 0 if unknown. */
  function playbackMeasure() {
    try {
      return playbackModel.measureNumber
    } catch (error) {
      return 0
    }
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
    var failure = "the plugin could not run the command"
    var firedAt = Date.now()
    try {
      if (root.pendingAction === "play" && !curScore) {
        ok = false
        failure = "MuseScore has no score open"
      } else if (root.pendingAction === "play" && !root.playReady()) {
        // MuseScore would swallow the request; say so instead of claiming a start.
        ok = false
        failure = "MuseScore was still loading this score's sounds and could not start yet"
      } else if (root.pendingAction === "play" && root.playbackRunning) {
        // Already playing; "play" would pause it. Leave it running.
        playback = "playing"
      } else if (root.pendingAction === "play") {
        if (root.pendingReset) {
          // Normally already true: the seek ran during the count-in.
          root.pendingReachedMeasure = root.playbackMeasure()
        }
        cmd("play")
        playback = "playing"
      } else if (root.pendingAction === "stop") {
        // A stop right after a start is not a start that failed.
        verifyTimer.stop()
        cmd("stop")
        root.playbackRunning = false
        playback = "stopped"
      } else {
        ok = false
        root.log("unsupported command: " + root.pendingAction)
      }
    } catch (error) {
      ok = false
      root.log("command failed: " + error)
    }

    var result = {
      type: "result",
      sequenceId: sequenceId,
      status: ok ? "succeeded" : "failed",
      playback: playback,
      controlPath: ok ? "musescore-plugin" : "musescore-plugin-failed",
      title: root.scoreName(),
      detail: ok ? root.playDetail() : failure,
      // This machine's clock, which is the adapter's: when the command arrived,
      // when it was due, and when it actually fired.
      receivedAt: root.pendingReceivedAt,
      dueLocalAt: root.pendingDueLocalAt,
      firedAt: firedAt
    }
    // The adapter reads this back as reachedMeasure and the host warns when it
    // does not match the song, so only claim a measure the selection reached.
    if (ok && root.pendingAction === "play" && root.pendingReset && root.pendingReachedMeasure > 0) {
      result.startMeasure = root.pendingReachedMeasure
    }
    root.send(result)
    root.sendStatus(playback)

    if (ok && root.pendingAction === "play") {
      // MuseScore prepares playback asynchronously and may still drop the
      // request; only a moving playback position proves the band hears it.
      root.verifySequenceId = sequenceId
      root.verifyFiredAt = firedAt
      verifyTimer.lastPosition = NaN
      verifyTimer.moves = 0
      verifyTimer.restart()
    }

    if (root.pendingAction === "play" && root.pendingReset) {
      // The play consumed the parked cursor; MuseScore moves it as it plays.
      root.preparedMeasure = 0
    } else if (root.pendingAction === "stop") {
      // Nothing is playing now, so put the cursor back on this song's starting
      // point and leave the next Play with nothing to seek either.
      root.prepareStartPoint({ startMeasure: root.songStartMeasure }, "playback stopped")
    }
  }

  Timer {
    id: downbeatTimer
    interval: 5
    repeat: true
    onTriggered: root.waitForDownbeat()
  }

  Timer {
    id: openTimer
    interval: 50
    repeat: false
    onTriggered: root.readPendingScore()
  }

  Timer {
    id: seekTimer
    interval: 20
    repeat: true
    onTriggered: root.stepSeek()
  }

  Timer {
    id: readyTimer
    interval: 100
    repeat: true
    onTriggered: root.reportOpenWhenReady()
  }

  // Watches the playback position after a Play. A seek to the start measure
  // moves it too, so "started" means it keeps moving past where the play put it.
  Timer {
    id: verifyTimer
    interval: 100
    repeat: true
    property double lastPosition: NaN
    property int moves: 0
    onTriggered: {
      var position = root.playPosition()
      var elapsed = Date.now() - root.verifyFiredAt
      if (isNaN(position)) {
        stop()
        return
      }
      if (!isNaN(lastPosition) && position > lastPosition) {
        moves += 1
      }
      lastPosition = position
      var started = moves >= 2
      if (!started && elapsed < root.verifyTimeoutMs) {
        return
      }
      stop()
      lastPosition = NaN
      moves = 0
      root.playbackRunning = started
      root.send({
        type: "playbackCheck",
        sequenceId: root.verifySequenceId,
        started: started,
        afterMs: elapsed,
        detail: started
          ? "MuseScore playback running " + elapsed + " ms after the downbeat"
          : "MuseScore did not start playback (its playback position did not move within "
            + root.verifyTimeoutMs + " ms)"
      })
      if (!started) {
        root.sendStatus("stopped")
      }
    }
  }

  // Reconnects when the adapter goes quiet. MuseScore's socket API has no
  // "disconnected" callback, so silence is the only sign the adapter was
  // restarted -- and a connection attempt that never answers (adapter not up
  // yet) is retried the same way.
  Timer {
    id: linkTimer
    interval: 1000
    repeat: true
    running: !root.dormant
    onTriggered: {
      var now = Date.now()
      if (root.connected) {
        if (now - root.lastInboundAt > root.linkTimeoutMs) {
          root.log("adapter went quiet; reconnecting")
          root.connect()
        }
        return
      }
      if (now - root.connectStartedAt > root.connectTimeoutMs) {
        root.connect()
      }
    }
  }

  // Keeps the adapter's "a bridge is attached" window open (it expires after 5 s)
  // and keeps the host's view of playback state fresh.
  Timer {
    id: heartbeatTimer
    interval: 2000
    repeat: true
    running: root.connected && !root.dormant
    onTriggered: root.sendStatus(undefined)
  }
}
