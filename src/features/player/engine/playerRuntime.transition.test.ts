import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePlaybackStream: vi.fn() }));

vi.mock("./streamResolver", () => ({
  resolvePlaybackStream: mocks.resolvePlaybackStream,
}));

import { playerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import { useMixStore } from "../store/mixStore";
import { linerDb } from "@/shared/storage";
import type { Track } from "@/shared/types";

const trackA: Track = {
  id: "a",
  title: "First",
  artists: "Artist",
  durationMs: 100_000,
  coverUrl: "",
  playCount: 0,
};
const trackB: Track = { ...trackA, id: "b", title: "Second" };

type RuntimeInternals = {
  audio: HTMLAudioElement;
  outgoing: { audio: HTMLAudioElement; startedAt: number | null } | null;
  pendingHandoff: { toTrackId: string } | null;
  currentTrackId: string | null;
  attachedTrackId: string | null;
  transitionFiredFor: string | null;
};

const runtime = () => playerRuntime as unknown as RuntimeInternals;

/** Pins media properties jsdom doesn't implement on one element. */
function fakeMedia(
  audio: HTMLAudioElement,
  props: Partial<
    Record<
      "paused" | "duration" | "currentTime" | "readyState" | "seeking",
      unknown
    >
  >,
) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(audio, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function clearFakeMedia(audio: HTMLAudioElement) {
  for (const key of [
    "paused",
    "duration",
    "currentTime",
    "readyState",
    "seeking",
  ]) {
    Reflect.deleteProperty(audio, key);
  }
}

/** Puts track A on the active deck, playing, `secondsLeft` from its end. */
function playingNearEnd(secondsLeft: number) {
  const audio = runtime().audio;
  audio.src = "blob:track-a";
  runtime().currentTrackId = trackA.id;
  runtime().attachedTrackId = trackA.id;
  runtime().transitionFiredFor = null;
  fakeMedia(audio, {
    paused: false,
    duration: 100,
    currentTime: 100 - secondsLeft,
    seeking: false,
  });
  audio.dispatchEvent(new Event("timeupdate"));
  return audio;
}

describe("PlayerRuntime transitions", () => {
  let dispatch: ReturnType<typeof vi.fn<(command: unknown) => void>>;
  let decks: HTMLAudioElement[];

  beforeEach(() => {
    vi.useFakeTimers();
    dispatch = vi.fn<(command: unknown) => void>();
    usePlayerStore.setState({
      status: "playing",
      currentTrack: trackA,
      queue: [trackA, trackB],
      currentIndex: 0,
      repeat: "off",
      playbackContext: null,
      positionMs: 0,
      durationMs: trackA.durationMs,
      volume: 1,
      playbackRate: 1,
      transitionSeconds: 5,
      error: null,
      dispatch,
    });
    useMixStore.setState({ mixes: {} });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    let blobs = 0;
    URL.createObjectURL = vi.fn(() => `blob:mock-${++blobs}`);
    URL.revokeObjectURL = vi.fn();
    // every deck reports it can play at once, so loads don't wait on a timeout
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(
      4,
    );
    decks = [];
  });

  afterEach(() => {
    (
      playerRuntime as unknown as { abortTransition: () => void }
    ).abortTransition();
    for (const deck of [runtime().audio, ...decks]) clearFakeMedia(deck);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does nothing while the slider is off", () => {
    usePlayerStore.setState({ transitionSeconds: 0 });
    playingNearEnd(3);
    expect(dispatch).not.toHaveBeenCalled();
    expect(runtime().pendingHandoff).toBeNull();
  });

  it("waits until the track is inside the transition window", () => {
    playingNearEnd(9);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks for the next track once the window starts", () => {
    playingNearEnd(4.5);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
    expect(runtime().pendingHandoff?.toTrackId).toBe(trackB.id);

    // further ticks don't ask again
    runtime().audio.dispatchEvent(new Event("timeupdate"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves the end of the queue alone", () => {
    usePlayerStore.setState({ queue: [trackA] });
    playingNearEnd(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("doesn't blend a track into itself on repeat-one", () => {
    usePlayerStore.setState({ repeat: "one" });
    playingNearEnd(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not skip twice when the old track ends before the next one is ready", () => {
    const audio = playingNearEnd(4);
    expect(dispatch).toHaveBeenCalledTimes(1);
    fakeMedia(audio, { currentTime: 100 });
    audio.dispatchEvent(new Event("ended"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("plays the next track on the other deck and blends the two", async () => {
    const deckA = playingNearEnd(5);
    vi.spyOn(linerDb, "getAudio").mockResolvedValue({
      trackId: trackB.id,
      blob: new Blob(["b"], { type: "audio/webm" }),
      byteSize: 1,
      lastPlayedAt: 0,
    } as never);
    vi.spyOn(linerDb, "putTrack").mockResolvedValue(undefined as never);

    usePlayerStore.setState({ currentTrack: trackB, currentIndex: 1 });
    await playerRuntime!.loadAndPlay(trackB);
    const deckB = runtime().audio;
    decks.push(deckB);
    expect(deckB).not.toBe(deckA);
    fakeMedia(deckB, { paused: false, duration: 100, currentTime: 0 });

    expect(deckB.id).toBe("liner-audio");
    expect(deckA.id).toBe("liner-audio-spare");
    expect(document.getElementById("liner-audio")).toBe(deckB);
    expect(runtime().outgoing?.audio).toBe(deckA);
    expect(runtime().outgoing?.startedAt).not.toBeNull();

    // halfway: both decks audible, constant power
    fakeMedia(deckA, { currentTime: 97.5 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(deckA.volume).toBeGreaterThan(0.5);
    expect(deckB.volume).toBeGreaterThan(0.5);
    expect(deckA.volume ** 2 + deckB.volume ** 2).toBeCloseTo(1, 1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(runtime().outgoing).toBeNull();
    expect(deckB.volume).toBe(1);
    expect(deckA.getAttribute("src")).toBeNull();
  });

  it("cuts the old track when the user pauses mid-transition", async () => {
    const deckA = playingNearEnd(5);
    vi.spyOn(linerDb, "getAudio").mockResolvedValue({
      trackId: trackB.id,
      blob: new Blob(["b"], { type: "audio/webm" }),
      byteSize: 1,
      lastPlayedAt: 0,
    } as never);
    vi.spyOn(linerDb, "putTrack").mockResolvedValue(undefined as never);

    await playerRuntime!.loadAndPlay(trackB);
    const deckB = runtime().audio;
    decks.push(deckB);
    fakeMedia(deckB, { paused: false, duration: 100, currentTime: 0 });
    expect(runtime().outgoing).not.toBeNull();

    playerRuntime!.pause();
    expect(runtime().outgoing).toBeNull();
    expect(deckA.getAttribute("src")).toBeNull();
  });

  it("uses the playlist's mix instead of the slider", () => {
    usePlayerStore.setState({
      transitionSeconds: 0,
      playbackContext: "playlist:p1",
    });
    useMixStore.setState({
      mixes: {
        p1: {
          enabled: true,
          defaultTransition: {
            style: "fade",
            volume: "crossfade",
            eq: "none",
            effect: "none",
            bars: 8,
            seconds: 6,
          },
          transitions: {},
        },
      },
    });
    playingNearEnd(5.5);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
