import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSITION,
  MAX_PLANNED_MS,
  MIN_PLANNED_MS,
  barsToMs,
  normalizeTransitionSettings,
  planNeedsFilters,
  planTransition,
  resolveAutoStyle,
  settingsForStyle,
  simpleFadePlan,
  transitionFrame,
} from "./transitions";

describe("simpleFadePlan", () => {
  it("is off at zero seconds", () => {
    expect(simpleFadePlan(0)).toBeNull();
  });

  it("crossfades for the chosen length", () => {
    expect(simpleFadePlan(5)).toEqual({
      durationMs: 5000,
      volume: "crossfade",
      eq: "none",
      effect: "none",
    });
  });
});

describe("resolveAutoStyle", () => {
  it("fades when a tempo is unknown", () => {
    expect(resolveAutoStyle(null, 120)).toBe("fade");
    expect(resolveAutoStyle(124, undefined)).toBe("fade");
  });

  it("blends matching tempos, including half and double time", () => {
    expect(resolveAutoStyle(124, 126)).toBe("blend");
    expect(resolveAutoStyle(70, 140)).toBe("blend");
    expect(resolveAutoStyle(174, 87)).toBe("blend");
  });

  it("rises over tempos that clash", () => {
    expect(resolveAutoStyle(100, 128)).toBe("rise");
  });
});

describe("planTransition", () => {
  it("measures length in bars of the outgoing track when its tempo is known", () => {
    const plan = planTransition({
      settings: settingsForStyle("fade"),
      fromBpm: 120,
      toBpm: 90,
    });
    // 8 bars of 4 beats at 120 bpm
    expect(plan?.durationMs).toBe(16_000);
    expect(barsToMs(8, 120)).toBe(16_000);
  });

  it("falls back to seconds without a tempo", () => {
    const plan = planTransition({ settings: settingsForStyle("fade", 4) });
    expect(plan?.durationMs).toBe(4000);
  });

  it("gets shorter when the track plays faster", () => {
    const plan = planTransition({
      settings: settingsForStyle("fade", 6),
      playbackRate: 1.5,
    });
    expect(plan?.durationMs).toBe(4000);
  });

  it("keeps lengths in a sane range", () => {
    const long = planTransition({
      settings: { ...settingsForStyle("blend"), bars: 16 },
      fromBpm: 60,
      toBpm: 60,
    });
    expect(long?.durationMs).toBe(MAX_PLANNED_MS);
    const short = planTransition({
      settings: { ...settingsForStyle("fade"), bars: 1 },
      fromBpm: 300,
      toBpm: 300,
    });
    expect(short?.durationMs).toBe(MIN_PLANNED_MS);
  });

  it("returns no plan for a cut", () => {
    expect(planTransition({ settings: settingsForStyle("cut") })).toBeNull();
  });

  it("turns auto into blend for matching tempos", () => {
    const plan = planTransition({
      settings: DEFAULT_TRANSITION,
      fromBpm: 128,
      toBpm: 128,
    });
    expect(plan).toMatchObject({ volume: "overlap", eq: "bass-swap" });
    expect(planNeedsFilters(plan)).toBe(true);
  });
});

describe("transitionFrame", () => {
  const fade = simpleFadePlan(6)!;

  it("starts on the old track and ends on the new one", () => {
    expect(transitionFrame(fade, 0).outgoing.gain).toBe(1);
    expect(transitionFrame(fade, 0).incoming.gain).toBe(0);
    expect(transitionFrame(fade, 1).outgoing.gain).toBeCloseTo(0);
    expect(transitionFrame(fade, 1).incoming.gain).toBe(1);
  });

  it("keeps a crossfade at constant power", () => {
    for (const p of [0.1, 0.3, 0.5, 0.8]) {
      const { outgoing, incoming } = transitionFrame(fade, p);
      expect(outgoing.gain ** 2 + incoming.gain ** 2).toBeCloseTo(1);
    }
  });

  it("keeps both loud in the middle of an overlap", () => {
    const overlap = { ...fade, volume: "overlap" as const };
    const mid = transitionFrame(overlap, 0.5);
    expect(mid.outgoing.gain).toBe(1);
    expect(mid.incoming.gain).toBe(1);
  });

  it("swaps the bass halfway through a blend", () => {
    const blend = {
      ...fade,
      volume: "overlap" as const,
      eq: "bass-swap" as const,
    };
    expect(transitionFrame(blend, 0.2).outgoing.bassDb).toBeCloseTo(0);
    expect(transitionFrame(blend, 0.2).incoming.bassDb).toBeLessThan(-20);
    expect(transitionFrame(blend, 0.8).outgoing.bassDb).toBeLessThan(-20);
    expect(transitionFrame(blend, 0.8).incoming.bassDb).toBeCloseTo(0);
  });

  it("sweeps the high-pass upward on the outgoing track only", () => {
    const rise = { ...fade, effect: "high-pass" as const };
    const early = transitionFrame(rise, 0.1).outgoing.highpassHz;
    const late = transitionFrame(rise, 0.9).outgoing.highpassHz;
    expect(late).toBeGreaterThan(early);
    expect(transitionFrame(rise, 0.9).incoming.highpassHz).toBe(0);
  });

  it("clamps progress outside 0..1", () => {
    expect(transitionFrame(fade, -1)).toEqual(transitionFrame(fade, 0));
    expect(transitionFrame(fade, 2)).toEqual(transitionFrame(fade, 1));
  });
});

describe("normalizeTransitionSettings", () => {
  it("rejects junk", () => {
    expect(normalizeTransitionSettings(null)).toBeNull();
    expect(normalizeTransitionSettings({ style: "wobble" })).toBeNull();
  });

  it("fills missing or invalid fields with defaults", () => {
    expect(
      normalizeTransitionSettings({ style: "rise", bars: 3, seconds: 99 }),
    ).toEqual({
      ...DEFAULT_TRANSITION,
      style: "rise",
      seconds: 12,
    });
  });
});
