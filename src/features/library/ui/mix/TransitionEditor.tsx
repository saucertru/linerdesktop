import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download2Line, LeftLine, PauseFill, PlayFill } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import Button from "@/shared/ui/Button";
import MenuSelect from "@/shared/ui/MenuSelect";
import CoverImage from "@/features/covers/ui/CoverImage";
import type { Track } from "@/shared/types";
import { playerEngine } from "@/features/player/engine/playerEngine";
import { playerRuntime } from "@/features/player/engine/playerRuntime";
import { useMixStore } from "@/features/player/store/mixStore";
import { useTrackAnalysisStore } from "@/features/player/store/trackAnalysisStore";
import type { Waveform } from "@/features/player/engine/audioAnalysis";
import {
  analyzeTrack,
  cachedWaveform,
  decodeSegment,
  hasLocalAudio,
} from "@/features/player/engine/trackAnalyzer";
import {
  audibleEndMs,
  audibleStartMs,
} from "@/features/player/engine/transitionPlanner";
import {
  PREVIEW_LEAD_MS,
  TransitionPreview,
  previewRanges,
} from "@/features/player/engine/transitionPreview";
import {
  DEFAULT_TRANSITION,
  TRANSITION_BARS,
  isUsableBpm,
  planTransition,
  settingsForStyle,
  transitionKey,
  type TransitionBars,
  type TransitionEffect,
  type TransitionEq,
  type TransitionPlan,
  type TransitionSettings,
  type TransitionStyle,
  type TransitionVolume,
} from "@/features/player/engine/transitions";
import TransitionWaveform from "./TransitionWaveform";
import {
  EFFECT_OPTIONS,
  EQ_OPTIONS,
  SECONDS_OPTIONS,
  STYLE_ORDER,
  VOLUME_OPTIONS,
  effectLabel,
  eqLabel,
  matchesPreset,
  pinAuto,
  styleLabel,
  volumeLabel,
} from "./mixLabels";

type LoadState =
  "checking" | "needs-audio" | "downloading" | "analyzing" | "ready" | "failed";

// a cut has no blend; draw it as a hairline so the editor still shows both tracks
const CUT_DISPLAY_PLAN: TransitionPlan = {
  durationMs: 250,
  volume: "cut",
  eq: "none",
  effect: "none",
};

export interface TransitionEditorProps {
  playlistId: string;
  from: Track;
  to: Track;
  onBack: () => void;
}

function TrackRow({ track, bpm }: { track: Track; bpm: number | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-[10px]">
      <div className="relative h-[36px] w-[36px] shrink-0 overflow-hidden rounded-control bg-fill">
        {track.coverUrl && (
          <CoverImage
            src={track.coverUrl}
            alt={track.title}
            fill
            sizes="36px"
            className="object-cover"
            draggable={false}
            unoptimized
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-[500] text-text-primary">
          {track.title}
        </span>
        <span className="truncate text-body text-text-tertiary">
          {track.artists}
        </span>
      </div>
      {isUsableBpm(bpm) && (
        <span className="shrink-0 rounded-control bg-fill px-[8px] py-[3px] text-caption font-[600] tabular-nums text-text-secondary">
          {t("mix.bpm", { bpm: Math.round(bpm) })}
        </span>
      )}
    </div>
  );
}

export default function TransitionEditor({
  playlistId,
  from,
  to,
  onBack,
}: TransitionEditorProps) {
  const { t } = useTranslation();
  const key = transitionKey(from.id, to.id);
  const mix = useMixStore((state) => state.mixes[playlistId]);
  const setTransition = useMixStore((state) => state.setTransition);
  const override = mix?.transitions[key];
  const settings: TransitionSettings =
    override ?? mix?.defaultTransition ?? DEFAULT_TRANSITION;

  const fromAnalysis = useTrackAnalysisStore((state) => state.byTrack[from.id]);
  const toAnalysis = useTrackAnalysisStore((state) => state.byTrack[to.id]);
  const fromBpm = fromAnalysis?.bpm ?? null;
  const toBpm = toAnalysis?.bpm ?? null;

  const [loadState, setLoadState] = useState<LoadState>("checking");
  const [waves, setWaves] = useState<{
    from: Waveform | null;
    to: Waveform | null;
  }>(() => ({ from: cachedWaveform(from.id), to: cachedWaveform(to.id) }));

  const load = useCallback(async () => {
    setLoadState("checking");
    const [hasFrom, hasTo] = await Promise.all([
      hasLocalAudio(from),
      hasLocalAudio(to),
    ]);
    if (!hasFrom || !hasTo) {
      setLoadState("needs-audio");
      return;
    }
    setLoadState("analyzing");
    const [a, b] = await Promise.all([
      analyzeTrack(from, { withWaveform: true }),
      analyzeTrack(to, { withWaveform: true }),
    ]);
    if (!a || !b) {
      setLoadState("failed");
      return;
    }
    setWaves({ from: a.waveform, to: b.waveform });
    setLoadState("ready");
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async () => {
    setLoadState("downloading");
    await Promise.all(
      [from, to].map(async (track) => {
        if (!(await hasLocalAudio(track))) {
          await playerRuntime?.preloadTrack(track).catch(() => {});
        }
      }),
    );
    const ready = await Promise.all([hasLocalAudio(from), hasLocalAudio(to)]);
    if (ready.every(Boolean)) void load();
    else setLoadState("failed");
  };

  const plan = useMemo(
    () => planTransition({ settings, fromBpm, toBpm }) ?? CUT_DISPLAY_PLAN,
    [settings, fromBpm, toBpm],
  );
  const fromDurationMs = fromAnalysis?.durationMs ?? from.durationMs ?? 0;
  const fromEndMs = audibleEndMs(from.id, fromDurationMs);
  const toStartMs = audibleStartMs(to.id);
  const leadMs = Math.min(
    PREVIEW_LEAD_MS,
    Math.max(0, fromEndMs - plan.durationMs),
  );

  // ---- preview -----------------------------------------------------------
  const previewRef = useRef<TransitionPreview | null>(null);
  const segmentCache = useRef(new Map<string, AudioBuffer>());
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "playing"
  >("idle");
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  useEffect(() => {
    const preview = new TransitionPreview();
    preview.onEnd = () => {
      setPreviewState("idle");
      setPlayheadMs(null);
    };
    previewRef.current = preview;
    return () => {
      preview.onEnd = undefined;
      preview.stop();
    };
  }, []);

  // a changed transition makes a running preview stale
  useEffect(() => {
    previewRef.current?.stop();
  }, [plan, fromEndMs, toStartMs]);

  useEffect(() => {
    if (previewState !== "playing") return;
    let frame = 0;
    const tick = () => {
      setPlayheadMs(previewRef.current?.positionMs() ?? null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewState]);

  const segment = async (track: Track, fromMs: number, toMs: number) => {
    const cacheKey = `${track.id}:${Math.round(fromMs)}:${Math.round(toMs)}`;
    const hit = segmentCache.current.get(cacheKey);
    if (hit) return hit;
    const decoded = await decodeSegment(track, fromMs, toMs);
    if (decoded) segmentCache.current.set(cacheKey, decoded);
    return decoded;
  };

  const togglePreview = async () => {
    const preview = previewRef.current;
    if (!preview) return;
    if (preview.isPlaying() || previewState === "loading") {
      preview.stop();
      setPreviewState("idle");
      return;
    }
    const status = playerEngine.getSnapshot().status;
    if (status === "playing" || status === "loading") playerEngine.pause();
    setPreviewState("loading");
    const ranges = previewRanges(plan, fromEndMs, toStartMs);
    try {
      const [outgoing, incoming] = await Promise.all([
        segment(from, ranges.outgoing.fromMs, ranges.outgoing.toMs),
        segment(to, ranges.incoming.fromMs, ranges.incoming.toMs),
      ]);
      if (!outgoing || !incoming) throw new Error("no audio");
      preview.play(
        outgoing,
        incoming,
        plan,
        fromEndMs - plan.durationMs - ranges.outgoing.fromMs,
      );
      setPreviewState("playing");
    } catch {
      setPreviewState("idle");
      setLoadState("failed");
    }
  };

  // ---- editing -----------------------------------------------------------
  const update = (patch: Partial<TransitionSettings>) =>
    setTransition(playlistId, key, {
      ...pinAuto(settings, fromBpm, toBpm),
      ...patch,
    });
  const choosePreset = (style: TransitionStyle) =>
    setTransition(playlistId, key, {
      ...settingsForStyle(style, settings.seconds),
      ...(style === "auto" ? {} : { bars: settingsForStyle(style).bars }),
    });

  const usesBars = isUsableBpm(fromBpm);
  const lengthValue = usesBars
    ? String(settings.bars)
    : String(settings.seconds);
  const lengthOptions = usesBars
    ? TRANSITION_BARS.map((bars) => ({
        value: String(bars),
        label: t("mix.bars", { count: bars }),
      }))
    : SECONDS_OPTIONS.map((seconds) => ({
        value: String(seconds),
        label: t("mix.seconds", { count: seconds }),
      }));
  const isCut = settings.style === "cut";
  const shownPlan = pinAuto(settings, fromBpm, toBpm);
  const activeStyle: TransitionStyle | null = matchesPreset(settings)
    ? settings.style
    : null;

  const canPreview = loadState === "ready";

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-[10px]">
        <button
          type="button"
          onClick={onBack}
          className="flex cursor-pointer items-center gap-[4px] border-0 bg-transparent p-0 text-body font-[500] text-text-secondary transition-colors hover:text-text-primary"
        >
          <LeftLine size={16} />
          {t("mix.back")}
        </button>
        <Button
          variant="secondary"
          onClick={() => void togglePreview()}
          disabled={!canPreview}
          className="!h-[32px] !rounded-[9px] !border-0 !text-label flex items-center gap-[7px] !bg-fill hover:!bg-fill-hover px-[16px] text-text-primary"
        >
          {previewState === "playing" ? (
            <PauseFill size={15} />
          ) : (
            <PlayFill size={15} />
          )}
          <span>
            {previewState === "playing"
              ? t("mix.stop_preview")
              : t("mix.preview")}
          </span>
        </Button>
      </div>

      <TrackRow track={from} bpm={fromBpm} />

      <div className="relative rounded-item bg-fill-subtle px-[8px] py-[6px]">
        <TransitionWaveform
          plan={plan}
          leadMs={leadMs}
          outgoing={waves.from}
          incoming={waves.to}
          fromEndMs={fromEndMs}
          toStartMs={toStartMs}
          playheadMs={playheadMs}
          className={cn(loadState !== "ready" && "opacity-30")}
        />
        {loadState !== "ready" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-[10px] px-[24px] text-center">
            <span className="text-body text-text-secondary">
              {loadState === "needs-audio"
                ? t("mix.needs_audio")
                : loadState === "downloading"
                  ? t("mix.downloading")
                  : loadState === "failed"
                    ? t("mix.unavailable")
                    : t("mix.analyzing")}
            </span>
            {loadState === "needs-audio" && (
              <Button
                variant="secondary"
                onClick={() => void download()}
                className="!h-[30px] !rounded-[9px] !border-0 !text-body flex items-center gap-[6px] !bg-fill hover:!bg-fill-hover px-[14px] text-text-primary"
              >
                <Download2Line size={15} />
                {t("mix.download")}
              </Button>
            )}
          </div>
        )}
      </div>

      <TrackRow track={to} bpm={toBpm} />

      <div className="grid grid-cols-3 gap-[8px]">
        <label className="flex min-w-0 flex-col gap-[6px]">
          <span className="text-caption font-[600] text-sky-500 dark:text-sky-400">
            {t("mix.volume")}
          </span>
          <MenuSelect<TransitionVolume>
            aria-label={t("mix.volume")}
            align="start"
            disabled={isCut}
            value={shownPlan.volume === "cut" ? "crossfade" : shownPlan.volume}
            options={VOLUME_OPTIONS.map((value) => ({
              value,
              label: volumeLabel(t, value),
            }))}
            onChange={(volume) => update({ volume })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-[6px]">
          <span className="text-caption font-[600] text-amber-500 dark:text-amber-400">
            {t("mix.eq")}
          </span>
          <MenuSelect<TransitionEq>
            aria-label={t("mix.eq")}
            disabled={isCut}
            value={shownPlan.eq}
            options={EQ_OPTIONS.map((value) => ({
              value,
              label: eqLabel(t, value),
            }))}
            onChange={(eq) => update({ eq })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-[6px]">
          <span className="text-caption font-[600] text-pink-500 dark:text-pink-400">
            {t("mix.effects")}
          </span>
          <MenuSelect<TransitionEffect>
            aria-label={t("mix.effects")}
            disabled={isCut}
            value={shownPlan.effect}
            options={EFFECT_OPTIONS.map((value) => ({
              value,
              label: effectLabel(t, value),
            }))}
            onChange={(effect) => update({ effect })}
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-[10px]">
        <div className="flex flex-wrap gap-[6px]">
          {STYLE_ORDER.map((style) => (
            <button
              key={style}
              type="button"
              onClick={() => choosePreset(style)}
              className={cn(
                "h-[30px] cursor-pointer rounded-control border-0 px-[12px] text-body font-[500] transition-colors",
                activeStyle === style
                  ? "bg-text-primary text-bg-primary"
                  : "bg-fill text-text-primary hover:bg-fill-hover",
              )}
            >
              {styleLabel(t, style)}
            </button>
          ))}
        </div>
        <MenuSelect
          aria-label={t("mix.length")}
          disabled={isCut}
          value={lengthValue}
          options={lengthOptions}
          onChange={(value) =>
            update(
              usesBars
                ? { bars: Number(value) as TransitionBars }
                : { seconds: Number(value) },
            )
          }
        />
      </div>

      {override && (
        <button
          type="button"
          onClick={() => setTransition(playlistId, key, null)}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-body text-text-tertiary transition-colors hover:text-text-primary"
        >
          {t("mix.use_default")}
        </button>
      )}
    </div>
  );
}
