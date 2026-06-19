export interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

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

  const bestSamples = [...samples]
    .sort((a, b) => a.rttMs - b.rttMs)
    .slice(0, Math.min(5, samples.length));

  return {
    rttMs: median(bestSamples.map((sample) => sample.rttMs)),
    offsetMs: median(bestSamples.map((sample) => sample.offsetMs))
  };
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
