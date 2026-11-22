import { beforeEach, describe, expect, it } from "vitest";
import { normalizeMix, useMixStore } from "./mixStore";
import { DEFAULT_TRANSITION, settingsForStyle } from "../engine/transitions";

describe("mixStore", () => {
  beforeEach(() => {
    useMixStore.setState({ mixes: {} });
  });

  it("turns a playlist's mix on with the default transition", () => {
    useMixStore.getState().setEnabled("p1", true);
    expect(useMixStore.getState().mixes.p1).toEqual({
      enabled: true,
      defaultTransition: DEFAULT_TRANSITION,
      transitions: {},
    });
  });

  it("keeps per-pair transitions and clears them back to the default", () => {
    const store = useMixStore.getState();
    store.setTransition("p1", "a>b", settingsForStyle("rise"));
    expect(useMixStore.getState().mixes.p1.transitions["a>b"].style).toBe(
      "rise",
    );
    store.setTransition("p1", "a>b", null);
    expect(useMixStore.getState().mixes.p1.transitions).toEqual({});
  });

  it("forgets a deleted playlist's mix", () => {
    useMixStore.getState().setEnabled("p1", true);
    useMixStore.getState().removeMix("p1");
    expect(useMixStore.getState().mixes.p1).toBeUndefined();
  });
});

describe("normalizeMix", () => {
  it("drops broken entries from storage", () => {
    expect(normalizeMix("nope")).toBeNull();
    expect(
      normalizeMix({
        enabled: "yes",
        defaultTransition: { style: "nonsense" },
        transitions: {
          "a>b": { style: "blend" },
          "no-arrow": { style: "fade" },
          "c>d": { style: "wobble" },
        },
      }),
    ).toEqual({
      enabled: false,
      defaultTransition: DEFAULT_TRANSITION,
      transitions: {
        "a>b": { ...DEFAULT_TRANSITION, style: "blend" },
      },
    });
  });
});
