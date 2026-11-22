// Tempo, waveform and silence for one track, worked out from decoded samples.
// Kept free of browser APIs so it can be tested with generated audio.

export interface TrackAnalysis {
  /** beats per minute, or null when the track has no steady beat */
  bpm: number | null;
  /** where sound starts and stops, so a mix skips silent intros and outros */
  firstAudibleMs: number;
  lastAudibleMs: number;
  durationMs: number;
}

export interface Waveform {
  /** loudest sample per bucket, 0..1 */
  peaks: Float32Array;
  msPerPeak: number;
}

export interface AnalysisResult {
  analysis: TrackAnalysis;
  waveform: Waveform;
}

export const WAVEFORM_MS_PER_PEAK = 10;
const ENVELOPE_HOP_MS = 10;
const SILENCE_THRESHOLD = 0.004; // about -48 dBFS
const MIN_BPM = 60;
const MAX_BPM = 200;
const PREFERRED_MIN_BPM = 75;
const PREFERRED_MAX_BPM = 180;
/** the best lag has to score this many times the average to count as a beat */
const MIN_BEAT_CLARITY = 2;

function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) mono[i] *= scale;
  return mono;
}

function computePeaks(mono: Float32Array, sampleRate: number): Float32Array {
  const bucket = Math.max(
    1,
    Math.round((sampleRate * WAVEFORM_MS_PER_PEAK) / 1000),
  );
  const peaks = new Float32Array(Math.ceil(mono.length / bucket));
  for (let b = 0; b < peaks.length; b++) {
    let max = 0;
    const end = Math.min(mono.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = Math.abs(mono[i]);
      if (v > max) max = v;
    }
    peaks[b] = Math.min(1, max);
  }
  return peaks;
}

/** RMS per hop. */
function computeEnvelope(mono: Float32Array, hop: number): Float32Array {
  const frames = Math.floor(mono.length / hop);
  const envelope = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) sum += mono[i] * mono[i];
    envelope[f] = Math.sqrt(sum / hop);
  }
  return envelope;
}

/** Low end only: kicks and bass carry the beat in most music. */
function lowPassed(mono: Float32Array, sampleRate: number): Float32Array {
  const cutoffHz = 180;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = 1 / sampleRate / (rc + 1 / sampleRate);
  const out = new Float32Array(mono.length);
  let prev = 0;
  for (let i = 0; i < mono.length; i++) {
    prev += alpha * (mono[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** How sharply energy rises, frame to frame (half-wave rectified). */
function onsetStrength(envelope: Float32Array): Float32Array {
  const onsets = new Float32Array(envelope.length);
  for (let i = 1; i < envelope.length; i++) {
    const rise = envelope[i] - envelope[i - 1];
    onsets[i] = rise > 0 ? rise : 0;
  }
  // remove the slow trend so loud sections don't dominate
  const window = 50;
  const smoothed = new Float32Array(onsets.length);
  let running = 0;
  for (let i = 0; i < onsets.length; i++) {
    running += onsets[i];
    if (i >= window) running -= onsets[i - window];
    const mean = running / Math.min(i + 1, window);
    smoothed[i] = Math.max(0, onsets[i] - mean);
  }
  return smoothed;
}

/** Leans toward common dance and pop tempos when two lags score close. */
function tempoPrior(bpm: number): number {
  const centre = Math.log2(120);
  const spread = 0.9;
  const d = (Math.log2(bpm) - centre) / spread;
  return Math.exp(-0.5 * d * d);
}

export function estimateBpm(
  mono: Float32Array,
  sampleRate: number,
): number | null {
  const hop = Math.max(1, Math.round((sampleRate * ENVELOPE_HOP_MS) / 1000));
  const framesPerSecond = sampleRate / hop;
  const onsets = onsetStrength(
    computeEnvelope(lowPassed(mono, sampleRate), hop),
  );
  if (onsets.length < framesPerSecond * 6) return null;

  let energy = 0;
  for (let i = 0; i < onsets.length; i++) energy += onsets[i] * onsets[i];
  if (energy <= 1e-9) return null;

  const minLag = Math.floor((60 / MAX_BPM) * framesPerSecond);
  const maxLag = Math.ceil((60 / MIN_BPM) * framesPerSecond);
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = lag; i < onsets.length; i++)
      sum += onsets[i] * onsets[i - lag];
    scores[lag] = sum / energy;
  }

  let bestLag = 0;
  let bestScore = 0;
  let total = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    total += scores[lag];
    count++;
    const bpm = (60 * framesPerSecond) / lag;
    const weighted = scores[lag] * tempoPrior(bpm);
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }
  if (!bestLag || count === 0) return null;
  const average = total / count;
  // noise scores about the same at every lag; a real beat towers over the rest
  if (scores[bestLag] < MIN_BEAT_CLARITY * average) return null;

  // parabolic interpolation around the peak for sub-frame precision
  const a = scores[bestLag - 1] ?? scores[bestLag];
  const b = scores[bestLag];
  const c = scores[bestLag + 1] ?? scores[bestLag];
  const denom = a - 2 * b + c;
  const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  let bpm =
    (60 * framesPerSecond) / (bestLag + Math.max(-0.5, Math.min(0.5, offset)));

  while (bpm < PREFERRED_MIN_BPM) bpm *= 2;
  while (bpm > PREFERRED_MAX_BPM) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

function audibleBounds(
  mono: Float32Array,
  sampleRate: number,
): { first: number; last: number } {
  const hop = Math.max(1, Math.round((sampleRate * ENVELOPE_HOP_MS) / 1000));
  const envelope = computeEnvelope(mono, hop);
  let first = 0;
  while (first < envelope.length && envelope[first] < SILENCE_THRESHOLD)
    first++;
  let last = envelope.length - 1;
  while (last > first && envelope[last] < SILENCE_THRESHOLD) last--;
  if (first >= envelope.length) return { first: 0, last: mono.length };
  return { first: first * hop, last: Math.min(mono.length, (last + 1) * hop) };
}

export function analyzeSamples(
  channels: Float32Array[],
  sampleRate: number,
): AnalysisResult {
  const mono = mixToMono(channels);
  const toMs = (samples: number) => Math.round((samples / sampleRate) * 1000);
  const bounds = audibleBounds(mono, sampleRate);
  return {
    analysis: {
      bpm: estimateBpm(mono, sampleRate),
      firstAudibleMs: toMs(bounds.first),
      lastAudibleMs: toMs(bounds.last),
      durationMs: toMs(mono.length),
    },
    waveform: {
      peaks: computePeaks(mono, sampleRate),
      msPerPeak: WAVEFORM_MS_PER_PEAK,
    },
  };
}

/** Peaks between two times, resampled to `count` bars for drawing. */
export function waveformSlice(
  waveform: Waveform,
  fromMs: number,
  toMs: number,
  count: number,
): number[] {
  const out: number[] = [];
  if (count <= 0 || toMs <= fromMs) return out;
  const span = (toMs - fromMs) / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor((fromMs + i * span) / waveform.msPerPeak);
    const end = Math.max(
      start + 1,
      Math.floor((fromMs + (i + 1) * span) / waveform.msPerPeak),
    );
    let max = 0;
    for (let p = start; p < end; p++) {
      if (p < 0 || p >= waveform.peaks.length) continue;
      if (waveform.peaks[p] > max) max = waveform.peaks[p];
    }
    out.push(max);
  }
  return out;
}
