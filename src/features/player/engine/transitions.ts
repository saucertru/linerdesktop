// How one track hands over to the next. Pure: no audio here, only the plan and the
// curves, so the runtime, the mix editor preview and the tests all share one source.

export type TransitionStyle = "auto" | "fade" | "rise" | "blend" | "cut";
/** crossfade: both move at once (equal power). overlap: both stay loud, the old one drops at the end. */
export type TransitionVolume = "crossfade" | "overlap" | "cut";
/** bass-swap: the old track loses its low end halfway while the new one gets it. */
export type TransitionEq = "none" | "bass-swap";
/** a filter sweep on the outgoing track */
export type TransitionEffect = "none" | "high-pass" | "low-pass";

export const TRANSITION_BARS = [1, 2, 4, 8, 16] as const;
export type TransitionBars = (typeof TRANSITION_BARS)[number];

export interface TransitionSettings {
  style: TransitionStyle;
  volume: TransitionVolume;
  eq: TransitionEq;
  effect: TransitionEffect;
  /** length in bars of the outgoing track; used when its tempo is known */
  bars: TransitionBars;
  /** length in seconds when the tempo is unknown */
  seconds: number;
}

export interface TransitionPlan {
  durationMs: number;
  volume: TransitionVolume;
  eq: TransitionEq;
  effect: TransitionEffect;
}

export interface DeckFrame {
  /** 0..1 multiplier on the user volume */
  gain: number;
  /** low-shelf gain in dB (0 = untouched) */
  bassDb: number;
  /** high-pass cutoff; 0 = off */
  highpassHz: number;
  /** low-pass cutoff; 0 = off */
  lowpassHz: number;
}

export interface TransitionFrame {
  outgoing: DeckFrame;
  incoming: DeckFrame;
}

export const MAX_TRANSITION_SECONDS = 12;
export const MIN_PLANNED_MS = 1000;
export const MAX_PLANNED_MS = 20_000;
export const DEFAULT_TRANSITION_SECONDS = 6;
export const BASS_SHELF_HZ = 220;
const BASS_CUT_DB = -26;
const HIGHPASS_END_HZ = 1400;
const LOWPASS_END_HZ = 350;
const FILTER_FLOOR_HZ = 20;
const FILTER_CEIL_HZ = 20_000;
/** tempos closer than this ratio mix well with a long blend */
const BLEND_TEMPO_TOLERANCE = 0.06;

type StylePreset = Omit<TransitionSettings, "style" | "seconds">;

export const STYLE_PRESETS: Record<
  Exclude<TransitionStyle, "auto">,
  StylePreset
> = {
  fade: { volume: "crossfade", eq: "none", effect: "none", bars: 8 },
  rise: { volume: "overlap", eq: "none", effect: "high-pass", bars: 8 },
  blend: { volume: "overlap", eq: "bass-swap", effect: "none", bars: 16 },
  cut: { volume: "cut", eq: "none", effect: "none", bars: 1 },
};

export const DEFAULT_TRANSITION: TransitionSettings = {
  style: "auto",
  ...STYLE_PRESETS.fade,
  seconds: DEFAULT_TRANSITION_SECONDS,
};

export function settingsForStyle(
  style: TransitionStyle,
  seconds = DEFAULT_TRANSITION_SECONDS,
): TransitionSettings {
  if (style === "auto") return { ...DEFAULT_TRANSITION, seconds };
  return { style, ...STYLE_PRESETS[style], seconds };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function barsToMs(bars: number, bpm: number): number {
  return (bars * 4 * 60_000) / bpm;
}

export function isUsableBpm(bpm: number | null | undefined): bpm is number {
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm >= 50;
}

/** What "auto" turns into for this pair of tracks. */
export function resolveAutoStyle(
  fromBpm: number | null | undefined,
  toBpm: number | null | undefined,
): Exclude<TransitionStyle, "auto"> {
  if (!isUsableBpm(fromBpm) || !isUsableBpm(toBpm)) return "fade";
  // half / double time still lines up
  const ratio = fromBpm / toBpm;
  const nearest = [0.5, 1, 2].reduce((best, candidate) =>
    Math.abs(ratio - candidate) < Math.abs(ratio - best) ? candidate : best,
  );
  return Math.abs(ratio / nearest - 1) <= BLEND_TEMPO_TOLERANCE
    ? "blend"
    : "rise";
}

export interface PlanInput {
  settings: TransitionSettings;
  fromBpm?: number | null;
  toBpm?: number | null;
  /** current playback speed: a faster track reaches its bars sooner */
  playbackRate?: number;
}

/** Turns settings into concrete timings. Returns null when there is nothing to blend. */
export function planTransition({
  settings,
  fromBpm,
  toBpm,
  playbackRate = 1,
}: PlanInput): TransitionPlan | null {
  let effective = settings;
  if (settings.style === "auto") {
    const style = resolveAutoStyle(fromBpm, toBpm);
    effective = { ...settings, ...STYLE_PRESETS[style] };
  }
  if (effective.volume === "cut") return null;

  const rate = playbackRate > 0 ? playbackRate : 1;
  const rawMs = isUsableBpm(fromBpm)
    ? barsToMs(effective.bars, fromBpm) / rate
    : (effective.seconds * 1000) / rate;
  if (!(rawMs > 0)) return null;

  return {
    durationMs: Math.round(clamp(rawMs, MIN_PLANNED_MS, MAX_PLANNED_MS)),
    volume: effective.volume,
    eq: effective.eq,
    effect: effective.effect,
  };
}

/** The plain crossfade used everywhere outside a mixed playlist. */
export function simpleFadePlan(seconds: number): TransitionPlan | null {
  if (!(seconds > 0)) return null;
  return {
    durationMs: Math.round(clamp(seconds, 0, MAX_TRANSITION_SECONDS) * 1000),
    volume: "crossfade",
    eq: "none",
    effect: "none",
  };
}

export function planNeedsFilters(plan: TransitionPlan | null): boolean {
  return Boolean(plan && (plan.eq !== "none" || plan.effect !== "none"));
}

const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Exponential sweep, so a filter moves evenly to the ear. */
const sweep = (from: number, to: number, t: number) =>
  from * Math.pow(to / from, clamp(t, 0, 1));

/** Every deck parameter at progress `p` (0 = start, 1 = done). */
export function transitionFrame(
  plan: TransitionPlan,
  progress: number,
): TransitionFrame {
  const p = clamp(progress, 0, 1);

  let outGain: number;
  let inGain: number;
  if (plan.volume === "overlap") {
    inGain = smooth(p / 0.3);
    outGain = 1 - smooth((p - 0.7) / 0.3);
  } else if (plan.volume === "cut") {
    inGain = p >= 0.5 ? 1 : 0;
    outGain = p >= 0.5 ? 0 : 1;
  } else {
    inGain = Math.sin((p * Math.PI) / 2);
    outGain = Math.cos((p * Math.PI) / 2);
  }

  let outBass = 0;
  let inBass = 0;
  if (plan.eq === "bass-swap") {
    const swap = smooth((p - 0.42) / 0.16);
    outBass = BASS_CUT_DB * swap;
    inBass = BASS_CUT_DB * (1 - swap);
  }

  let highpassHz = 0;
  let lowpassHz = 0;
  if (plan.effect === "high-pass") {
    highpassHz = sweep(FILTER_FLOOR_HZ, HIGHPASS_END_HZ, p);
  } else if (plan.effect === "low-pass") {
    lowpassHz = sweep(FILTER_CEIL_HZ, LOWPASS_END_HZ, p);
  }

  return {
    outgoing: {
      gain: clamp(outGain, 0, 1),
      bassDb: outBass,
      highpassHz,
      lowpassHz,
    },
    incoming: {
      gain: clamp(inGain, 0, 1),
      bassDb: inBass,
      highpassHz: 0,
      lowpassHz: 0,
    },
  };
}

export const NEUTRAL_DECK: DeckFrame = {
  gain: 1,
  bassDb: 0,
  highpassHz: 0,
  lowpassHz: 0,
};

/** Keys a transition by the pair of tracks it joins. */
export function transitionKey(fromTrackId: string, toTrackId: string): string {
  return `${fromTrackId}>${toTrackId}`;
}

export function normalizeTransitionSettings(
  value: unknown,
): TransitionSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TransitionSettings>;
  const styles: TransitionStyle[] = ["auto", "fade", "rise", "blend", "cut"];
  const volumes: TransitionVolume[] = ["crossfade", "overlap", "cut"];
  const eqs: TransitionEq[] = ["none", "bass-swap"];
  const effects: TransitionEffect[] = ["none", "high-pass", "low-pass"];
  if (!styles.includes(raw.style as TransitionStyle)) return null;
  return {
    style: raw.style as TransitionStyle,
    volume: volumes.includes(raw.volume as TransitionVolume)
      ? (raw.volume as TransitionVolume)
      : DEFAULT_TRANSITION.volume,
    eq: eqs.includes(raw.eq as TransitionEq)
      ? (raw.eq as TransitionEq)
      : DEFAULT_TRANSITION.eq,
    effect: effects.includes(raw.effect as TransitionEffect)
      ? (raw.effect as TransitionEffect)
      : DEFAULT_TRANSITION.effect,
    bars: (TRANSITION_BARS as readonly number[]).includes(raw.bars as number)
      ? (raw.bars as TransitionBars)
      : DEFAULT_TRANSITION.bars,
    seconds:
      typeof raw.seconds === "number" && Number.isFinite(raw.seconds)
        ? clamp(raw.seconds, 1, MAX_TRANSITION_SECONDS)
        : DEFAULT_TRANSITION.seconds,
  };
}
