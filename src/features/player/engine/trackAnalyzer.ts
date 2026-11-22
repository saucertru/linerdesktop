import type { Track } from "@/shared/types";
import { linerDb } from "@/shared/storage";
import { isLocalTrackId, localTrackAudioUrl } from "@/shared/media/local";
import { savedAudioUrl, savedTrackRecord } from "@/shared/media/saved";
import { log } from "@/shared/utils/logger";
import {
  WAVEFORM_MS_PER_PEAK,
  analyzeSamples,
  type AnalysisResult,
  type Waveform,
} from "./audioAnalysis";
import {
  getTrackAnalysis,
  useTrackAnalysisStore,
} from "../store/trackAnalysisStore";

// Decodes a track that is already on this device and measures it. Nothing is
// downloaded here: a track that isn't cached or local is skipped.

const DECODE_SAMPLE_RATE = 22_050;
const MAX_ANALYZED_MS = 15 * 60_000;
const WAVEFORM_CACHE_SIZE = 12;

const EMPTY_WAVEFORM: Waveform = {
  peaks: new Float32Array(0),
  msPerPeak: WAVEFORM_MS_PER_PEAK,
};

const waveforms = new Map<string, Waveform>();
const inFlight = new Map<string, Promise<AnalysisResult | null>>();
const failed = new Set<string>();

function rememberWaveform(trackId: string, waveform: Waveform) {
  waveforms.delete(trackId);
  waveforms.set(trackId, waveform);
  while (waveforms.size > WAVEFORM_CACHE_SIZE) {
    const oldest = waveforms.keys().next().value;
    if (oldest === undefined) break;
    waveforms.delete(oldest);
  }
}

async function readAudioBytes(track: Track): Promise<ArrayBuffer | null> {
  if (isLocalTrackId(track.id)) {
    const res = await fetch(localTrackAudioUrl(track.id));
    return res.ok ? res.arrayBuffer() : null;
  }
  const saved = savedTrackRecord(track.id);
  if (saved) {
    const res = await fetch(savedAudioUrl(saved));
    return res.ok ? res.arrayBuffer() : null;
  }
  const cached = await linerDb.getAudio(track.id);
  return cached?.blob ? cached.blob.arrayBuffer() : null;
}

async function decode(
  bytes: ArrayBuffer,
  sampleRate = DECODE_SAMPLE_RATE,
): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  // a throwaway context: decoding never touches the one that plays music
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  return ctx.decodeAudioData(bytes);
}

/** True when the track's audio can be read without downloading it. */
export async function hasLocalAudio(track: Track): Promise<boolean> {
  if (isLocalTrackId(track.id) || savedTrackRecord(track.id)) return true;
  return Boolean(await linerDb.getAudio(track.id));
}

/**
 * Decodes the stretch of `track` between two times at a quality fit for listening,
 * keeping only that stretch in memory. Used by the transition preview.
 */
export async function decodeSegment(
  track: Track,
  fromMs: number,
  toMs: number,
  sampleRate = 32_000,
): Promise<AudioBuffer | null> {
  const bytes = await readAudioBytes(track);
  if (!bytes) return null;
  const full = await decode(bytes, sampleRate);
  if (!full) return null;
  const start = Math.max(0, Math.floor((fromMs / 1000) * full.sampleRate));
  const end = Math.min(full.length, Math.ceil((toMs / 1000) * full.sampleRate));
  const length = Math.max(1, end - start);
  const segment = new AudioBuffer({
    length,
    numberOfChannels: full.numberOfChannels,
    sampleRate: full.sampleRate,
  });
  for (let c = 0; c < full.numberOfChannels; c++) {
    segment.copyToChannel(
      full.getChannelData(c).subarray(start, start + length),
      c,
    );
  }
  return segment;
}

export function cachedWaveform(trackId: string): Waveform | null {
  return waveforms.get(trackId) ?? null;
}

export function canAnalyze(track: Track): boolean {
  return !track.durationMs || track.durationMs <= MAX_ANALYZED_MS;
}

/**
 * Measures `track` if its audio is on this device. Resolves null when it isn't, or
 * when decoding fails. `withWaveform` forces a decode even if the numbers are known.
 */
export function analyzeTrack(
  track: Track,
  { withWaveform = false } = {},
): Promise<AnalysisResult | null> {
  const known = getTrackAnalysis(track.id);
  const wave = waveforms.get(track.id);
  if (known && (!withWaveform || wave)) {
    return Promise.resolve({
      analysis: known,
      waveform: wave ?? EMPTY_WAVEFORM,
    });
  }
  if (!canAnalyze(track) || (failed.has(track.id) && !withWaveform)) {
    return Promise.resolve(null);
  }
  const pending = inFlight.get(track.id);
  if (pending) return pending;

  const job = (async () => {
    try {
      const bytes = await readAudioBytes(track);
      if (!bytes) return null;
      const buffer = await decode(bytes);
      if (!buffer) return null;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        buffer.getChannelData(i),
      );
      const result = analyzeSamples(channels, buffer.sampleRate);
      useTrackAnalysisStore.getState().put(track.id, result.analysis);
      rememberWaveform(track.id, result.waveform);
      failed.delete(track.id);
      log(
        "cyan",
        "mix",
        `analyzed "${track.title}": ${result.analysis.bpm ?? "no steady"} bpm`,
      );
      return result;
    } catch (error) {
      failed.add(track.id);
      log(
        "yellow",
        "mix",
        `could not analyze "${track.title}": ${String(error)}`,
      );
      return null;
    } finally {
      inFlight.delete(track.id);
    }
  })();
  inFlight.set(track.id, job);
  return job;
}
