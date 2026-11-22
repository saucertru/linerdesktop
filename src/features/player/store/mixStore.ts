import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_TRANSITION,
  normalizeTransitionSettings,
  type TransitionSettings,
} from "../engine/transitions";

// Mixes are kept on this device: the playlists API has nowhere to store them.

export interface PlaylistMix {
  enabled: boolean;
  /** used for any pair of tracks without its own settings */
  defaultTransition: TransitionSettings;
  /** keyed by transitionKey(fromTrackId, toTrackId) */
  transitions: Record<string, TransitionSettings>;
}

interface MixState {
  mixes: Record<string, PlaylistMix>;
  setEnabled: (playlistId: string, enabled: boolean) => void;
  setDefaultTransition: (
    playlistId: string,
    settings: TransitionSettings,
  ) => void;
  /** null clears the override, so the pair follows the playlist default again */
  setTransition: (
    playlistId: string,
    key: string,
    settings: TransitionSettings | null,
  ) => void;
  resetTransitions: (playlistId: string) => void;
  removeMix: (playlistId: string) => void;
}

export const MIX_STORAGE_KEY = "liner_playlist_mixes_v1";

export const emptyMix = (): PlaylistMix => ({
  enabled: false,
  defaultTransition: { ...DEFAULT_TRANSITION },
  transitions: {},
});

export function normalizeMix(value: unknown): PlaylistMix | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PlaylistMix>;
  const transitions: Record<string, TransitionSettings> = {};
  if (raw.transitions && typeof raw.transitions === "object") {
    for (const [key, settings] of Object.entries(raw.transitions)) {
      const normalized = normalizeTransitionSettings(settings);
      if (normalized && key.includes(">")) transitions[key] = normalized;
    }
  }
  return {
    enabled: raw.enabled === true,
    defaultTransition: normalizeTransitionSettings(raw.defaultTransition) ?? {
      ...DEFAULT_TRANSITION,
    },
    transitions,
  };
}

export const useMixStore = create<MixState>()(
  persist(
    (set, get) => {
      const update = (
        playlistId: string,
        change: (mix: PlaylistMix) => PlaylistMix,
      ) => {
        const current = get().mixes[playlistId] ?? emptyMix();
        set({ mixes: { ...get().mixes, [playlistId]: change(current) } });
      };

      return {
        mixes: {},
        setEnabled: (playlistId, enabled) =>
          update(playlistId, (mix) => ({ ...mix, enabled })),
        setDefaultTransition: (playlistId, settings) =>
          update(playlistId, (mix) => ({
            ...mix,
            defaultTransition: settings,
          })),
        setTransition: (playlistId, key, settings) =>
          update(playlistId, (mix) => {
            const transitions = { ...mix.transitions };
            if (settings) transitions[key] = settings;
            else delete transitions[key];
            return { ...mix, transitions };
          }),
        resetTransitions: (playlistId) =>
          update(playlistId, (mix) => ({ ...mix, transitions: {} })),
        removeMix: (playlistId) => {
          if (!get().mixes[playlistId]) return;
          const { [playlistId]: _removed, ...rest } = get().mixes;
          set({ mixes: rest });
        },
      };
    },
    {
      name: MIX_STORAGE_KEY,
      version: 1,
      partialize: (state) => ({ mixes: state.mixes }),
      merge: (persisted, current) => {
        const mixes: Record<string, PlaylistMix> = {};
        const raw = (persisted as { mixes?: unknown } | undefined)?.mixes;
        if (raw && typeof raw === "object") {
          for (const [id, value] of Object.entries(raw)) {
            const mix = normalizeMix(value);
            if (mix) mixes[id] = mix;
          }
        }
        return { ...current, mixes };
      },
    },
  ),
);

export function mixForPlaylist(playlistId: string | null): PlaylistMix | null {
  if (!playlistId) return null;
  return useMixStore.getState().mixes[playlistId] ?? null;
}
