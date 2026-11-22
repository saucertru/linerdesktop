import {
  BASS_SHELF_HZ,
  transitionFrame,
  type DeckFrame,
  type TransitionPlan,
} from "./transitions";

// Plays one transition on its own, from decoded audio, with the same curves the
// player uses. The editor shows the same window: a few seconds of the old track,
// the blend, then a few seconds of the new track.

export const PREVIEW_LEAD_MS = 4000;
export const PREVIEW_TAIL_MS = 4000;
const CURVE_POINTS = 96;
const START_DELAY_S = 0.06;

export interface PreviewRanges {
  /** stretch of the outgoing track to play, in its own time */
  outgoing: { fromMs: number; toMs: number };
  /** stretch of the incoming track to play, in its own time */
  incoming: { fromMs: number; toMs: number };
  /** whole preview length */
  totalMs: number;
}

/**
 * Where each track is heard. `fromEndMs` is where the old track's sound ends,
 * `toStartMs` where the new track's sound begins.
 */
export function previewRanges(
  plan: TransitionPlan,
  fromEndMs: number,
  toStartMs: number,
): PreviewRanges {
  const blendStart = Math.max(0, fromEndMs - plan.durationMs);
  const lead = Math.min(PREVIEW_LEAD_MS, blendStart);
  return {
    outgoing: { fromMs: blendStart - lead, toMs: fromEndMs },
    incoming: {
      fromMs: toStartMs,
      toMs: toStartMs + plan.durationMs + PREVIEW_TAIL_MS,
    },
    totalMs: lead + plan.durationMs + PREVIEW_TAIL_MS,
  };
}

/** One deck parameter sampled across the blend, for setValueCurveAtTime. */
export function sampleCurve(
  plan: TransitionPlan,
  pick: (frame: { outgoing: DeckFrame; incoming: DeckFrame }) => number,
  points = CURVE_POINTS,
): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    curve[i] = pick(transitionFrame(plan, i / (points - 1)));
  }
  return curve;
}

type Side = "outgoing" | "incoming";

export class TransitionPreview {
  private ctx: AudioContext | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private leadS = 0;
  public onEnd?: () => void;

  isPlaying(): boolean {
    return this.ctx !== null;
  }

  /** Milliseconds from the start of the blend (negative during the lead-in). */
  positionMs(): number | null {
    if (!this.ctx) return null;
    return (this.ctx.currentTime - this.startedAt - this.leadS) * 1000;
  }

  play(
    outgoing: AudioBuffer,
    incoming: AudioBuffer,
    plan: TransitionPlan,
    leadMs: number,
  ): void {
    this.stop();
    const ctx = new AudioContext();
    this.ctx = ctx;
    const t0 = ctx.currentTime + START_DELAY_S;
    const lead = leadMs / 1000;
    const duration = plan.durationMs / 1000;
    const nyquist = ctx.sampleRate / 2;
    this.startedAt = t0;
    this.leadS = lead;

    const deck = (buffer: AudioBuffer, side: Side, startAt: number) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      const bass = ctx.createBiquadFilter();
      bass.type = "lowshelf";
      bass.frequency.value = BASS_SHELF_HZ;
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      source.connect(bass).connect(highpass).connect(lowpass).connect(gain);
      gain.connect(ctx.destination);

      const first = transitionFrame(plan, 0)[side];
      gain.gain.value = first.gain;
      bass.gain.value = first.bassDb;
      highpass.frequency.value = Math.max(10, first.highpassHz);
      lowpass.frequency.value =
        first.lowpassHz > 0 ? Math.min(nyquist, first.lowpassHz) : nyquist;

      const blendAt = t0 + lead;
      gain.gain.setValueCurveAtTime(
        sampleCurve(plan, (f) => f[side].gain),
        blendAt,
        duration,
      );
      bass.gain.setValueCurveAtTime(
        sampleCurve(plan, (f) => f[side].bassDb),
        blendAt,
        duration,
      );
      highpass.frequency.setValueCurveAtTime(
        sampleCurve(plan, (f) => Math.max(10, f[side].highpassHz)),
        blendAt,
        duration,
      );
      lowpass.frequency.setValueCurveAtTime(
        sampleCurve(plan, (f) =>
          f[side].lowpassHz > 0
            ? Math.min(nyquist, f[side].lowpassHz)
            : nyquist,
        ),
        blendAt,
        duration,
      );
      source.start(startAt);
    };

    deck(outgoing, "outgoing", t0);
    deck(incoming, "incoming", t0 + lead);

    const totalMs = leadMs + plan.durationMs + PREVIEW_TAIL_MS;
    this.endTimer = setTimeout(() => this.stop(), totalMs + 150);
  }

  stop(): void {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    void ctx.close().catch(() => {});
    this.onEnd?.();
  }
}
