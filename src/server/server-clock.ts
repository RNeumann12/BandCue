/**
 * Room time for the coordinator: wall-clock epoch anchored once at startup and
 * advanced by the monotonic clock. Every scheduled downbeat, auto-stop timer,
 * and clock-sync reply is derived from this value, so an OS NTP step on the
 * coordinator mid-rehearsal cannot shift room time (clients would otherwise
 * all adopt the jump at once and in-flight scheduled starts would move).
 *
 * The anchor intentionally never re-syncs to Date.now(): absolute accuracy
 * does not matter for BandCue, only that all devices agree on the same
 * monotonic room timeline.
 */
const anchorWallMs = Date.now();
const anchorPerfMs = performance.now();

export function serverNow(): number {
  return Math.round(anchorWallMs + (performance.now() - anchorPerfMs));
}
