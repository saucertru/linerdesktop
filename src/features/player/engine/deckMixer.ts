import { BASS_SHELF_HZ, type DeckFrame } from "./transitions";

// Two audio elements ("decks") can play at once during a transition. Normally neither
// touches Web Audio and their own .volume does the fading. When a transition needs a
// filter, or the effects graph is on, every deck is routed into one shared bus:
//
//   deck A ─ source ─┐
//                    ├─ bus ─ (effects graph | speakers)
//   deck B ─ source ─┘
//
// Filters sit between a deck's source and the bus only while a transition uses them,
// so an idle player pays for nothing extra.

const TRANSPARENT_HIGHPASS_HZ = 10;
const TRANSPARENT_LOWPASS_HZ = 22_000;
const PARAM_SMOOTHING_S = 0.02;

interface DeckFilters {
  bass: BiquadFilterNode;
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
}

interface DeckChain {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  filters: DeckFilters | null;
  filtered: boolean;
}

interface BusState {
  ctx: AudioContext;
  bus: GainNode;
  claimed: boolean;
}

type AudioWindow = Window & {
  __liner_audio_context?: AudioContext;
  __liner_media_source_node?: MediaElementAudioSourceNode;
  __liner_deck_bus?: BusState;
  webkitAudioContext?: typeof AudioContext;
};

type DeckElement = HTMLAudioElement & {
  __liner_source_node?: MediaElementAudioSourceNode;
  __liner_deck_chain?: DeckChain;
};

const isNeutral = (frame: DeckFrame | null): boolean =>
  !frame ||
  (Math.abs(frame.bassDb) < 0.05 &&
    frame.highpassHz <= TRANSPARENT_HIGHPASS_HZ &&
    (frame.lowpassHz === 0 || frame.lowpassHz >= TRANSPARENT_LOWPASS_HZ));

export class DeckMixer {
  private decks = new Set<HTMLAudioElement>();

  /** Lets the mixer know about a deck without routing it anywhere yet. */
  register(audio: HTMLAudioElement): void {
    this.decks.add(audio);
  }

  /** True while any known deck is producing sound. */
  isAnyDeckPlaying(): boolean {
    for (const deck of this.decks) {
      if (!deck.paused && !deck.ended) return true;
    }
    return false;
  }

  context(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const win = window as AudioWindow;
    if (win.__liner_audio_context) return win.__liner_audio_context;
    const AudioCtx = window.AudioContext || win.webkitAudioContext;
    if (!AudioCtx) return null;
    win.__liner_audio_context = new AudioCtx();
    return win.__liner_audio_context;
  }

  private busState(ctx: AudioContext): BusState {
    const win = window as AudioWindow;
    const existing = win.__liner_deck_bus;
    if (existing && existing.ctx === ctx) return existing;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(ctx.destination);
    const state: BusState = { ctx, bus, claimed: false };
    win.__liner_deck_bus = state;
    return state;
  }

  private chainFor(audio: DeckElement, ctx: AudioContext): DeckChain | null {
    const existing = audio.__liner_deck_chain;
    if (existing && existing.ctx === ctx) return existing;
    const win = window as AudioWindow;
    // a media element can feed exactly one source node, ever
    let source = audio.__liner_source_node;
    if (!source && win.__liner_media_source_node?.mediaElement === audio) {
      source = win.__liner_media_source_node;
    }
    if (!source) {
      try {
        source = ctx.createMediaElementSource(audio);
      } catch {
        return null;
      }
    }
    audio.__liner_source_node = source;
    const chain: DeckChain = { ctx, source, filters: null, filtered: false };
    audio.__liner_deck_chain = chain;
    return chain;
  }

  /**
   * Routes `audio` into the bus. The browser never lets an element leave Web Audio
   * again, so this is one-way.
   */
  connect(audio: HTMLAudioElement): GainNode | null {
    const ctx = this.context();
    if (!ctx) return null;
    this.register(audio);
    const state = this.busState(ctx);
    const deck = audio as DeckElement;
    const fresh = !deck.__liner_deck_chain;
    const chain = this.chainFor(deck, ctx);
    if (!chain) return null;
    if (fresh || !chain.filtered) {
      try {
        chain.source.disconnect();
      } catch {}
      chain.source.connect(state.bus);
      chain.filtered = false;
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return state.bus;
  }

  /** Routes every registered deck, so none of them bypasses the effects graph. */
  connectAll(): GainNode | null {
    let bus: GainNode | null = null;
    for (const deck of this.decks) bus = this.connect(deck) ?? bus;
    return bus;
  }

  isConnected(audio: HTMLAudioElement): boolean {
    return Boolean((audio as DeckElement).__liner_deck_chain);
  }

  /** Hands the bus to the effects graph: it stops going straight to the speakers. */
  claimBus(): GainNode | null {
    const ctx = this.context();
    if (!ctx) return null;
    const state = this.busState(ctx);
    if (!state.claimed) {
      try {
        state.bus.disconnect(ctx.destination);
      } catch {}
      state.claimed = true;
    }
    return state.bus;
  }

  private filtersFor(ctx: AudioContext, chain: DeckChain): DeckFilters {
    if (chain.filters) return chain.filters;
    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = BASS_SHELF_HZ;
    bass.gain.value = 0;
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = TRANSPARENT_HIGHPASS_HZ;
    highpass.Q.value = 0.9;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = TRANSPARENT_LOWPASS_HZ;
    lowpass.Q.value = 0.9;
    bass.connect(highpass);
    highpass.connect(lowpass);
    chain.filters = { bass, highpass, lowpass };
    return chain.filters;
  }

  /**
   * Applies one frame of a transition to a deck. A neutral frame (or null) takes the
   * filters out of the path again.
   */
  setFrame(audio: HTMLAudioElement, frame: DeckFrame | null): void {
    const deck = audio as DeckElement;
    const chain = deck.__liner_deck_chain;
    const ctx = this.context();
    if (!chain || !ctx || chain.ctx !== ctx) return;
    const bus = this.busState(ctx).bus;

    if (isNeutral(frame)) {
      if (!chain.filtered) return;
      try {
        chain.source.disconnect();
        chain.filters?.lowpass.disconnect();
      } catch {}
      chain.source.connect(bus);
      chain.filtered = false;
      if (chain.filters) {
        chain.filters.bass.gain.value = 0;
        chain.filters.highpass.frequency.value = TRANSPARENT_HIGHPASS_HZ;
        chain.filters.lowpass.frequency.value = TRANSPARENT_LOWPASS_HZ;
      }
      return;
    }

    const filters = this.filtersFor(ctx, chain);
    if (!chain.filtered) {
      try {
        chain.source.disconnect();
      } catch {}
      chain.source.connect(filters.bass);
      filters.lowpass.connect(bus);
      chain.filtered = true;
    }
    const now = ctx.currentTime;
    const f = frame!;
    filters.bass.gain.setTargetAtTime(f.bassDb, now, PARAM_SMOOTHING_S);
    filters.highpass.frequency.setTargetAtTime(
      Math.max(TRANSPARENT_HIGHPASS_HZ, f.highpassHz),
      now,
      PARAM_SMOOTHING_S,
    );
    filters.lowpass.frequency.setTargetAtTime(
      f.lowpassHz > 0
        ? Math.min(TRANSPARENT_LOWPASS_HZ, f.lowpassHz)
        : TRANSPARENT_LOWPASS_HZ,
      now,
      PARAM_SMOOTHING_S,
    );
  }
}

export const deckMixer = new DeckMixer();
