import { describe, expect, it } from "vitest";
import { settingsForStyle } from "@/features/player/engine/transitions";
import {
  lengthLabel,
  matchesPreset,
  pinAuto,
  shownStyleLabel,
} from "./mixLabels";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

describe("mix labels", () => {
  it("names a preset by its style and a tweaked one as custom", () => {
    const blend = settingsForStyle("blend");
    expect(shownStyleLabel(t, blend)).toBe("mix.style_blend");
    expect(matchesPreset({ ...blend, eq: "none" })).toBe(false);
    expect(shownStyleLabel(t, { ...blend, eq: "none" })).toBe(
      "mix.style_custom",
    );
  });

  it("shows bars when the tempo is known and seconds otherwise", () => {
    const fade = settingsForStyle("fade", 6);
    expect(lengthLabel(t, fade, 124)).toBe('mix.bars:{"count":8}');
    expect(lengthLabel(t, fade, null)).toBe('mix.seconds:{"count":6}');
  });

  it("pins auto to what it would pick before a field is edited", () => {
    const auto = settingsForStyle("auto");
    expect(pinAuto(auto, 128, 128).style).toBe("blend");
    expect(pinAuto(auto, 128, 128).eq).toBe("bass-swap");
    expect(pinAuto(auto, null, null).style).toBe("fade");
    const rise = settingsForStyle("rise");
    expect(pinAuto(rise, 128, 128)).toBe(rise);
  });
});
