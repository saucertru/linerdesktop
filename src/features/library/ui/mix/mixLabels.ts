import {
  STYLE_PRESETS,
  isUsableBpm,
  resolveAutoStyle,
  type TransitionEffect,
  type TransitionEq,
  type TransitionSettings,
  type TransitionStyle,
  type TransitionVolume,
} from "@/features/player/engine/transitions";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export const STYLE_ORDER: TransitionStyle[] = [
  "auto",
  "fade",
  "rise",
  "blend",
  "cut",
];

export const VOLUME_OPTIONS: TransitionVolume[] = ["crossfade", "overlap"];
export const EQ_OPTIONS: TransitionEq[] = ["none", "bass-swap"];
export const EFFECT_OPTIONS: TransitionEffect[] = [
  "none",
  "high-pass",
  "low-pass",
];
export const SECONDS_OPTIONS = [2, 4, 6, 8, 10, 12];

export const styleLabel = (t: Translate, style: TransitionStyle) =>
  t(`mix.style_${style}`);

export const volumeLabel = (t: Translate, value: TransitionVolume) =>
  t(`mix.volume_${value}`);

export const eqLabel = (t: Translate, value: TransitionEq) =>
  t(value === "bass-swap" ? "mix.eq_bass_swap" : "mix.eq_none");

export const effectLabel = (t: Translate, value: TransitionEffect) =>
  t(
    value === "high-pass"
      ? "mix.effect_high_pass"
      : value === "low-pass"
        ? "mix.effect_low_pass"
        : "mix.effect_none",
  );

/** True when a non-auto style's fields still match its preset. */
export function matchesPreset(settings: TransitionSettings): boolean {
  if (settings.style === "auto") return true;
  const preset = STYLE_PRESETS[settings.style];
  return (
    preset.volume === settings.volume &&
    preset.eq === settings.eq &&
    preset.effect === settings.effect
  );
}

/** "Blend", "Custom", or for auto, what auto picks when the tempos are known. */
export function shownStyleLabel(
  t: Translate,
  settings: TransitionSettings,
): string {
  if (settings.style === "cut") return styleLabel(t, "cut");
  return matchesPreset(settings)
    ? styleLabel(t, settings.style)
    : t("mix.style_custom");
}

export function lengthLabel(
  t: Translate,
  settings: TransitionSettings,
  fromBpm: number | null | undefined,
): string {
  return isUsableBpm(fromBpm)
    ? t("mix.bars", { count: settings.bars })
    : t("mix.seconds", { count: settings.seconds });
}

/**
 * The concrete settings a user is editing. Editing one field of "auto" first
 * pins it to what auto would have picked, so the change is heard.
 */
export function pinAuto(
  settings: TransitionSettings,
  fromBpm: number | null | undefined,
  toBpm: number | null | undefined,
): TransitionSettings {
  if (settings.style !== "auto") return settings;
  const style = resolveAutoStyle(fromBpm, toBpm);
  return { ...settings, style, ...STYLE_PRESETS[style] };
}
