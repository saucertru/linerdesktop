import { memo, useMemo } from "react";
import {
  waveformSlice,
  type Waveform,
} from "@/features/player/engine/audioAnalysis";
import {
  transitionFrame,
  type TransitionPlan,
} from "@/features/player/engine/transitions";
import { PREVIEW_TAIL_MS } from "@/features/player/engine/transitionPreview";
import { cn } from "@/shared/lib";

export interface TransitionWaveformProps {
  plan: TransitionPlan;
  leadMs: number;
  outgoing: Waveform | null;
  incoming: Waveform | null;
  /** where the old track's sound ends, in its own time */
  fromEndMs: number;
  /** where the new track's sound starts, in its own time */
  toStartMs: number;
  /** preview playhead, in ms from the start of the blend */
  playheadMs?: number | null;
  className?: string;
}

const WIDTH = 1000;
const HEIGHT = 160;
const LANE = 62;
const OUT_TOP = 6;
const IN_TOP = HEIGHT - LANE - 6;
const BAR_STEP = 5;
const CURVE_POINTS = 60;

const toX = (ms: number, leadMs: number, totalMs: number) =>
  ((ms + leadMs) / totalMs) * WIDTH;

function bars(values: number[], x0: number, x1: number, top: number) {
  if (values.length === 0) return "";
  const step = (x1 - x0) / values.length;
  const mid = top + LANE / 2;
  let d = "";
  values.forEach((value, i) => {
    const h = Math.max(1.5, value * LANE);
    const x = x0 + i * step + step * 0.2;
    d += `M${x.toFixed(1)} ${(mid - h / 2).toFixed(1)}v${h.toFixed(1)}`;
  });
  return d;
}

/**
 * The end of the old track above the start of the new one, lined up in time, with
 * the blend shaded and its volume, EQ and filter curves drawn over it.
 */
export const TransitionWaveform = memo(function TransitionWaveform({
  plan,
  leadMs,
  outgoing,
  incoming,
  fromEndMs,
  toStartMs,
  playheadMs,
  className,
}: TransitionWaveformProps) {
  const totalMs = leadMs + plan.durationMs + PREVIEW_TAIL_MS;
  const x = (ms: number) => toX(ms, leadMs, totalMs);
  const blendX0 = x(0);
  const blendX1 = x(plan.durationMs);

  const outPath = useMemo(() => {
    if (!outgoing) return "";
    const x0 = toX(-leadMs, leadMs, totalMs);
    const x1 = toX(plan.durationMs, leadMs, totalMs);
    const count = Math.max(1, Math.round((x1 - x0) / BAR_STEP));
    const values = waveformSlice(
      outgoing,
      fromEndMs - plan.durationMs - leadMs,
      fromEndMs,
      count,
    );
    return bars(values, x0, x1, OUT_TOP);
  }, [outgoing, fromEndMs, plan.durationMs, leadMs, totalMs]);

  const inPath = useMemo(() => {
    if (!incoming) return "";
    const x0 = toX(0, leadMs, totalMs);
    const x1 = toX(plan.durationMs + PREVIEW_TAIL_MS, leadMs, totalMs);
    const count = Math.max(1, Math.round((x1 - x0) / BAR_STEP));
    const values = waveformSlice(
      incoming,
      toStartMs,
      toStartMs + plan.durationMs + PREVIEW_TAIL_MS,
      count,
    );
    return bars(values, x0, x1, IN_TOP);
  }, [incoming, toStartMs, plan.durationMs, leadMs, totalMs]);

  const curves = useMemo(() => {
    const top = OUT_TOP;
    const bottom = IN_TOP + LANE;
    const y = (value: number) => bottom - value * (bottom - top);
    const line = (pick: (p: number) => number) =>
      Array.from({ length: CURVE_POINTS }, (_, i) => {
        const p = i / (CURVE_POINTS - 1);
        const px = blendX0 + p * (blendX1 - blendX0);
        return `${i ? "L" : "M"}${px.toFixed(1)} ${y(pick(p)).toFixed(1)}`;
      }).join("");
    const frame = (p: number) => transitionFrame(plan, p);
    return {
      volumeOut: line((p) => frame(p).outgoing.gain),
      volumeIn: line((p) => frame(p).incoming.gain),
      eq:
        plan.eq === "none"
          ? ""
          : line((p) => 1 + frame(p).outgoing.bassDb / 26),
      effect:
        plan.effect === "none"
          ? ""
          : line((p) => {
              const f = frame(p).outgoing;
              if (plan.effect === "high-pass")
                return (
                  1 -
                  Math.log10(Math.max(20, f.highpassHz) / 20) / Math.log10(70)
                );
              return (
                Math.log10(Math.max(350, f.lowpassHz) / 350) /
                Math.log10(20000 / 350)
              );
            }),
    };
  }, [plan, blendX0, blendX1]);

  const playheadX =
    playheadMs === null || playheadMs === undefined
      ? null
      : Math.min(WIDTH, Math.max(0, x(playheadMs)));

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("block h-[160px] w-full select-none", className)}
      role="img"
    >
      <rect
        x={blendX0}
        y={0}
        width={Math.max(0, blendX1 - blendX0)}
        height={HEIGHT}
        rx={6}
        className="fill-black/[0.05] dark:fill-white/[0.07]"
      />
      <path
        d={outPath}
        strokeWidth={2.4}
        strokeLinecap="round"
        className="stroke-text-secondary"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={inPath}
        strokeWidth={2.4}
        strokeLinecap="round"
        className="stroke-text-primary"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={curves.volumeOut}
        fill="none"
        strokeWidth={2}
        className="stroke-sky-400"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={curves.volumeIn}
        fill="none"
        strokeWidth={2}
        className="stroke-sky-400"
        vectorEffect="non-scaling-stroke"
      />
      {curves.eq && (
        <path
          d={curves.eq}
          fill="none"
          strokeWidth={2}
          className="stroke-amber-400"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {curves.effect && (
        <path
          d={curves.effect}
          fill="none"
          strokeWidth={2}
          className="stroke-pink-400"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {playheadX !== null && (
        <line
          x1={playheadX}
          x2={playheadX}
          y1={0}
          y2={HEIGHT}
          strokeWidth={1.5}
          className="stroke-text-primary"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
});

export default TransitionWaveform;
