import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { Track } from "@/shared/types";

vi.mock("framer-motion", () => {
  const cache: Record<string, unknown> = {};
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              (
                { children, ...props }: Record<string, unknown>,
                ref: React.Ref<HTMLElement>,
              ) => {
                const clean = { ...props };
                for (const key of [
                  "initial",
                  "animate",
                  "exit",
                  "transition",
                  "layout",
                ])
                  delete clean[key];
                return React.createElement(
                  prop,
                  { ref, ...clean },
                  children as React.ReactNode,
                );
              },
            );
          }
          return cache[prop];
        },
      },
    ),
  };
});

vi.mock("@/features/player/engine/trackAnalyzer", () => ({
  hasLocalAudio: vi.fn().mockResolvedValue(false),
  analyzeTrack: vi.fn().mockResolvedValue(null),
  cachedWaveform: vi.fn().mockReturnValue(null),
  decodeSegment: vi.fn().mockResolvedValue(null),
}));

import MixDialog from "./MixDialog";
import { useMixStore } from "@/features/player/store/mixStore";

// @ts-expect-error act support flag for the jsdom environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const track = (id: string, title: string): Track => ({
  id,
  title,
  artists: "Artist",
  durationMs: 200_000,
  coverUrl: "",
  playCount: 0,
});

const tracks = [
  track("a", "Still Riding"),
  track("b", "Something In The Air"),
  track("c", "Midnight"),
];

describe("MixDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        <MixDialog
          open
          onOpenChange={() => {}}
          playlistId="p1"
          tracks={tracks}
        />,
      );
    });

  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;

  beforeEach(() => {
    useMixStore.setState({ mixes: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists one transition per pair of songs", () => {
    render();
    expect(document.body.textContent).toContain("Mix this playlist");
    expect(document.body.textContent).toContain("→ Something In The Air");
    expect(document.body.textContent).toContain("→ Midnight");
  });

  it("turns the mix on from the switch", () => {
    render();
    const toggle = document.querySelector(
      'button[role="switch"]',
    ) as HTMLButtonElement;
    act(() => toggle.click());
    expect(useMixStore.getState().mixes.p1?.enabled).toBe(true);
  });

  it("sets the transition every pair uses", () => {
    useMixStore.getState().setEnabled("p1", true);
    render();
    act(() => button("Blend")?.click());
    expect(useMixStore.getState().mixes.p1.defaultTransition.style).toBe(
      "blend",
    );
  });

  it("opens one transition and edits only that pair", async () => {
    useMixStore.getState().setEnabled("p1", true);
    render();
    const row = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("→ Something In The Air"),
    );
    await act(async () => {
      row?.click();
    });
    expect(document.body.textContent).toContain("All transitions");
    expect(document.body.textContent).toContain(
      "Download both songs to see and hear this transition.",
    );

    act(() => button("Rise")?.click());
    const mix = useMixStore.getState().mixes.p1;
    expect(mix.transitions["a>b"].style).toBe("rise");
    expect(mix.transitions["b>c"]).toBeUndefined();

    act(() => button("Use the playlist's transition")?.click());
    expect(useMixStore.getState().mixes.p1.transitions["a>b"]).toBeUndefined();
  });
});
