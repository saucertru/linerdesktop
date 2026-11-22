import type { Track } from "@/shared/types";
import type { PlayerState } from "../store/playerStore";
import { mixForPlaylist, type PlaylistMix } from "../store/mixStore";
import { getTrackAnalysis } from "../store/trackAnalysisStore";
import { isRadioContext } from "./radioMode";
import { PLAYLIST_CONTEXT_PREFIX } from "./playlistShuffle";
import {
  planTransition,
  simpleFadePlan,
  transitionKey,
  type TransitionPlan,
  type TransitionSettings,
} from "./transitions";

type QueueView = Pick<
  PlayerState,
  "queue" | "currentIndex" | "repeat" | "playbackContext"
>;

/** Which queue index plays next. Shared with the engine so both agree. */
export function autoNextIndex(
  state: QueueView,
  isAutoEnd: boolean,
): number | null {
  const queueSize = state.queue.length;
  if (queueSize === 0 || state.currentIndex < 0) return null;
  if (isAutoEnd && state.repeat === "one") return state.currentIndex;
  if (state.currentIndex + 1 < queueSize) return state.currentIndex + 1;
  // radio never wraps to its first track; skipNext refills it instead
  if (isRadioContext(state.playbackContext)) return null;
  if (state.repeat === "all" || state.repeat === "one") return 0;
  return null;
}

export function playlistIdFromContext(
  context: string | null | undefined,
): string | null {
  if (!context?.startsWith(PLAYLIST_CONTEXT_PREFIX)) return null;
  return context.slice(PLAYLIST_CONTEXT_PREFIX.length) || null;
}

export function activeMix(
  state: Pick<PlayerState, "playbackContext">,
): { playlistId: string; mix: PlaylistMix } | null {
  const playlistId = playlistIdFromContext(state.playbackContext);
  const mix = mixForPlaylist(playlistId);
  return playlistId && mix?.enabled ? { playlistId, mix } : null;
}

export function transitionSettingsFor(
  mix: PlaylistMix,
  fromTrackId: string,
  toTrackId: string,
): TransitionSettings {
  return (
    mix.transitions[transitionKey(fromTrackId, toTrackId)] ??
    mix.defaultTransition
  );
}

export interface UpcomingTransition {
  next: Track;
  plan: TransitionPlan;
  /** true when a playlist mix decided this, not the global slider */
  mixed: boolean;
}

/** The transition into the track that would play after this one, if any. */
export function planUpcoming(
  state: QueueView &
    Pick<PlayerState, "currentTrack" | "playbackRate" | "transitionSeconds">,
): UpcomingTransition | null {
  const current = state.currentTrack;
  if (!current) return null;
  const index = autoNextIndex(state, true);
  if (index === null || index === state.currentIndex) return null;
  const next = state.queue[index];
  if (!next || next.id === current.id) return null;

  const mixed = activeMix(state);
  if (mixed) {
    const plan = planTransition({
      settings: transitionSettingsFor(mixed.mix, current.id, next.id),
      fromBpm: getTrackAnalysis(current.id)?.bpm,
      toBpm: getTrackAnalysis(next.id)?.bpm,
      playbackRate: state.playbackRate,
    });
    return plan ? { next, plan, mixed: true } : null;
  }

  const plan = simpleFadePlan(state.transitionSeconds);
  return plan ? { next, plan, mixed: false } : null;
}

// a cached analysis from another upload of the "same" track would cut it short
const DURATION_MATCH_MS = 3000;
const MAX_SKIPPED_INTRO_MS = 10_000;
const MIN_SKIPPED_INTRO_MS = 300;

/** Where sound actually ends, for mixed playlists; otherwise the file's end. */
export function audibleEndMs(trackId: string, durationMs: number): number {
  const analysis = getTrackAnalysis(trackId);
  if (!analysis || durationMs <= 0) return durationMs;
  if (Math.abs(analysis.durationMs - durationMs) > DURATION_MATCH_MS)
    return durationMs;
  return Math.min(durationMs, Math.max(0, analysis.lastAudibleMs));
}

/** How far into the next track a mix should start, to skip a silent intro. */
export function audibleStartMs(trackId: string): number {
  const first = getTrackAnalysis(trackId)?.firstAudibleMs ?? 0;
  return first >= MIN_SKIPPED_INTRO_MS && first <= MAX_SKIPPED_INTRO_MS
    ? first
    : 0;
}
