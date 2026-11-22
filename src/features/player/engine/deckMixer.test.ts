import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DeckMixer } from "./deckMixer";
import { NEUTRAL_DECK } from "./transitions";

class FakeParam {
  constructor(public value: number) {}
  setTargetAtTime(value: number) {
    this.value = value;
  }
}

class FakeNode {
  outputs = new Set<FakeNode>();
  constructor(
    public ctx: FakeContext,
    public kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect(target: FakeNode) {
    this.outputs.add(target);
    return target;
  }
  disconnect(target?: FakeNode) {
    if (target) this.outputs.delete(target);
    else this.outputs.clear();
  }
}

class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  gain = new FakeParam(0);
  Q = new FakeParam(1);
}

class FakeContext {
  nodes: FakeNode[] = [];
  state = "running";
  currentTime = 0;
  destination = new FakeNode(this, "destination");
  sources = 0;
  createGain() {
    const node = new FakeNode(this, "gain") as FakeNode & { gain: FakeParam };
    node.gain = new FakeParam(1);
    return node;
  }
  createBiquadFilter() {
    return new FakeBiquad(this, "biquad");
  }
  createMediaElementSource(mediaElement: HTMLMediaElement) {
    this.sources++;
    const node = new FakeNode(this, "source") as FakeNode & {
      mediaElement: HTMLMediaElement;
    };
    node.mediaElement = mediaElement;
    return node;
  }
  resume() {
    return Promise.resolve();
  }
}

/** Kinds of node between `from` and the speakers. */
function pathToSpeakers(from: FakeNode): string[] | null {
  const walk = (node: FakeNode, seen: string[]): string[] | null => {
    if (node.kind === "destination") return seen;
    for (const next of node.outputs) {
      const found = walk(next, [...seen, next.kind]);
      if (found) return found;
    }
    return null;
  };
  return walk(from, []);
}

describe("DeckMixer", () => {
  let mixer: DeckMixer;
  let ctx: FakeContext;
  let deckA: HTMLAudioElement;
  let deckB: HTMLAudioElement;

  const sourceOf = (deck: HTMLAudioElement) =>
    (deck as unknown as { __liner_source_node: FakeNode }).__liner_source_node;

  beforeEach(() => {
    const win = window as unknown as Record<string, unknown>;
    delete win.__liner_audio_context;
    delete win.__liner_deck_bus;
    delete win.__liner_media_source_node;
    ctx = new FakeContext();
    win.__liner_audio_context = ctx;
    mixer = new DeckMixer();
    deckA = document.createElement("audio");
    deckB = document.createElement("audio");
  });

  afterEach(() => {
    const win = window as unknown as Record<string, unknown>;
    delete win.__liner_audio_context;
    delete win.__liner_deck_bus;
  });

  it("routes a deck through one bus to the speakers", () => {
    mixer.connect(deckA);
    expect(pathToSpeakers(sourceOf(deckA))).toEqual(["gain", "destination"]);
    expect(mixer.isConnected(deckA)).toBe(true);
    expect(mixer.isConnected(deckB)).toBe(false);
  });

  it("creates a media source only once per element", () => {
    mixer.connect(deckA);
    mixer.connect(deckA);
    expect(ctx.sources).toBe(1);
  });

  it("connects every registered deck at once", () => {
    mixer.register(deckA);
    mixer.register(deckB);
    mixer.connectAll();
    expect(mixer.isConnected(deckA)).toBe(true);
    expect(mixer.isConnected(deckB)).toBe(true);
  });

  it("inserts filters only while a transition needs them", () => {
    mixer.connect(deckA);
    mixer.setFrame(deckA, {
      gain: 1,
      bassDb: -20,
      highpassHz: 800,
      lowpassHz: 0,
    });
    expect(pathToSpeakers(sourceOf(deckA))).toEqual([
      "biquad",
      "biquad",
      "biquad",
      "gain",
      "destination",
    ]);
    mixer.setFrame(deckA, NEUTRAL_DECK);
    expect(pathToSpeakers(sourceOf(deckA))).toEqual(["gain", "destination"]);
  });

  it("drives the filter values from the frame", () => {
    mixer.connect(deckA);
    mixer.setFrame(deckA, {
      gain: 1,
      bassDb: -12,
      highpassHz: 600,
      lowpassHz: 900,
    });
    const biquads = ctx.nodes.filter(
      (node): node is FakeBiquad => node instanceof FakeBiquad,
    );
    const byType = Object.fromEntries(biquads.map((b) => [b.type, b]));
    expect(byType.lowshelf.gain.value).toBe(-12);
    expect(byType.highpass.frequency.value).toBe(600);
    expect(byType.lowpass.frequency.value).toBe(900);
  });

  it("ignores frames for decks that never joined Web Audio", () => {
    mixer.setFrame(deckB, {
      gain: 1,
      bassDb: -20,
      highpassHz: 0,
      lowpassHz: 0,
    });
    expect(ctx.nodes.some((node) => node instanceof FakeBiquad)).toBe(false);
  });

  it("stops sending the bus to the speakers once the effects graph claims it", () => {
    mixer.connect(deckA);
    const bus = mixer.claimBus() as unknown as FakeNode;
    expect(bus.outputs.has(ctx.destination)).toBe(false);
    expect(pathToSpeakers(sourceOf(deckA))).toBeNull();
  });

  it("reports when any deck is playing", () => {
    mixer.register(deckA);
    mixer.register(deckB);
    Object.defineProperty(deckA, "paused", { value: true });
    Object.defineProperty(deckB, "paused", { value: false });
    expect(mixer.isAnyDeckPlaying()).toBe(true);
  });
});
