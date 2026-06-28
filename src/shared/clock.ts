export interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

// How many recent samples each client keeps. A wider window gives the lowest-RTT
// selection more candidates to pick the cleanest round trip from.
export const CLOCK_SAMPLE_WINDOW = 20;

// On connect, clients fire a short burst of rapid samples so the offset estimate
// converges in ~2s instead of the ~10s it took at one sample per second. After
// the burst they settle into the steady cadence.
export const CLOCK_WARMUP_SAMPLES = 8;
export const CLOCK_WARMUP_INTERVAL_MS = 250;
export const CLOCK_STEADY_INTERVAL_MS = 1000;

// Offset estimates are smoothed across updates (EMA) to damp network jitter, but
// a change larger than CLOCK_OFFSET_JUMP_MS is adopted immediately because it
// signals a real clock step (e.g. the OS resynced its clock) rather than noise.
export const CLOCK_OFFSET_JUMP_MS = 250;
export const CLOCK_OFFSET_SMOOTHING = 0.3;

// Number of samples before the offset is considered trustworthy enough to play.
export const CLOCK_MIN_SAMPLES = 5;

export function calculateClockSample(
  clientSentAt: number,
  clientReceivedAt: number,
  serverReceivedAt: number,
  serverSentAt: number
): ClockSample {
  const rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt);
  const offsetMs =
    (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2;

  return {
    rttMs: Math.max(0, rttMs),
    offsetMs
  };
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarizeClock(samples: ClockSample[]): ClockSample {
  if (samples.length === 0) {
    return { rttMs: 0, offsetMs: 0 };
  }

  const sorted = [...samples].sort((a, b) => a.rttMs - b.rttMs);
  const bestSamples = sorted.slice(0, Math.min(5, sorted.length));

  return {
    // Median RTT of the best samples is a fair gauge for the timing-quality badge.
    rttMs: median(bestSamples.map((sample) => sample.rttMs)),
    // Offset comes from the single lowest-RTT sample: the round trip with the
    // least queuing delay yields the most accurate clock offset (NTP clock filter).
    // The remaining jitter is damped over time by blendOffset at the call sites.
    offsetMs: sorted[0]?.offsetMs ?? 0
  };
}

// Smooths a freshly measured offset into the running estimate. Small changes are
// eased in to absorb jitter; a change beyond jumpMs is taken as-is so a genuine
// clock step is adopted immediately instead of being slewed over many updates.
export function blendOffset(
  previous: number | undefined,
  next: number,
  smoothing = CLOCK_OFFSET_SMOOTHING,
  jumpMs = CLOCK_OFFSET_JUMP_MS
): number {
  if (previous === undefined || !Number.isFinite(previous)) {
    return next;
  }
  if (Math.abs(next - previous) > jumpMs) {
    return next;
  }
  return previous + smoothing * (next - previous);
}

// Whether a client has enough stable samples for its offset to be trusted for
// scheduling. Used by the host UI to warn before starting playback too early.
export function isClockConverged(sampleCount: number, jitterMs: number): boolean {
  return sampleCount >= CLOCK_MIN_SAMPLES && jitterMs < 35;
}

export function calculateJitterMs(samples: ClockSample[]): number {
  if (samples.length < 2) {
    return 0;
  }

  const offsets = samples.map((sample) => sample.offsetMs);
  const center = median(offsets);
  const deviations = offsets.map((offset) => Math.abs(offset - center));
  return median(deviations);
}

export function delayUntilServerTime(
  scheduledServerTime: number,
  localNow: number,
  serverOffsetMs: number
): number {
  return Math.max(0, scheduledServerTime - (localNow + serverOffsetMs));
}
