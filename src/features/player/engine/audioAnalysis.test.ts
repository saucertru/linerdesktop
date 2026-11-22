import { describe, expect, it } from "vitest";
import { analyzeSamples, estimateBpm, waveformSlice } from "./audioAnalysis";

const RATE = 22_050;

/** A kick drum on every beat, with optional silence around it. */
function beatTrack(
  bpm: number,
  seconds: number,
  { leadSilence = 0, tailSilence = 0, noise = 0 } = {},
): Float32Array {
  const total = Math.round((leadSilence + seconds + tailSilence) * RATE);
  const samples = new Float32Array(total);
  const start = Math.round(leadSilence * RATE);
  const end = start + Math.round(seconds * RATE);
  const beat = (60 / bpm) * RATE;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  for (let i = start; i < end; i++) {
    const sinceBeat = (i - start) % beat;
    const t = sinceBeat / RATE;
    const kick = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 18);
    samples[i] = 0.8 * kick + noise * random();
  }
  return samples;
}

describe("estimateBpm", () => {
  for (const bpm of [92, 120, 128, 140, 174]) {
    it(`finds ${bpm} bpm`, () => {
      const found = estimateBpm(beatTrack(bpm, 20, { noise: 0.05 }), RATE);
      expect(found).not.toBeNull();
      // 174 may fold to half time; both line up in a mix
      const candidates = [bpm, bpm / 2, bpm * 2];
      const error = Math.min(
        ...candidates.map((c) => Math.abs(found! - c) / c),
      );
      expect(error).toBeLessThan(0.02);
    });
  }

  it("gives up on steady noise with no beat", () => {
    let seed = 3;
    const noise = new Float32Array(RATE * 20).map(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.4;
    });
    expect(estimateBpm(noise, RATE)).toBeNull();
  });

  it("gives up on clips too short to tell", () => {
    expect(estimateBpm(beatTrack(120, 3), RATE)).toBeNull();
  });
});

describe("analyzeSamples", () => {
  it("finds where the sound starts and stops", () => {
    const samples = beatTrack(120, 12, { leadSilence: 1.5, tailSilence: 4 });
    const { analysis } = analyzeSamples([samples], RATE);
    expect(analysis.durationMs).toBe(17_500);
    expect(Math.abs(analysis.firstAudibleMs - 1500)).toBeLessThan(30);
    // the last kick decays a little past its start; it ends well before the silence
    expect(analysis.lastAudibleMs).toBeLessThan(13_600);
    expect(analysis.lastAudibleMs).toBeGreaterThan(13_000);
  });

  it("mixes stereo down before measuring", () => {
    const left = beatTrack(128, 10);
    const right = new Float32Array(left.length);
    const { analysis, waveform } = analyzeSamples([left, right], RATE);
    expect(analysis.bpm).not.toBeNull();
    expect(Math.max(...waveform.peaks)).toBeLessThanOrEqual(0.5);
  });

  it("treats total silence as all-silent without crashing", () => {
    const { analysis } = analyzeSamples([new Float32Array(RATE * 8)], RATE);
    expect(analysis.bpm).toBeNull();
    expect(analysis.firstAudibleMs).toBe(0);
  });
});

describe("waveformSlice", () => {
  it("resamples peaks to the number of bars to draw", () => {
    const waveform = {
      peaks: Float32Array.from([0.1, 0.9, 0.2, 0.4, 0.3, 0.8]),
      msPerPeak: 10,
    };
    expect(waveformSlice(waveform, 0, 60, 3).map((v) => +v.toFixed(2))).toEqual(
      [0.9, 0.4, 0.8],
    );
    expect(
      waveformSlice(waveform, 50, 90, 2).map((v) => +v.toFixed(2)),
    ).toEqual([0.8, 0]);
  });
});
