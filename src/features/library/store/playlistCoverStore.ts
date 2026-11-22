import { create } from "zustand";

/** Playlist id → version of the custom cover picked on this device. */
export type PlaylistCoverVersions = Record<string, number>;

export type PickPlaylistCoverResult = "saved" | "canceled" | "unreadable";

interface PlaylistCoverState {
  versions: PlaylistCoverVersions;
  loaded: boolean;
  load: () => Promise<void>;
  pick: (playlistId: string) => Promise<PickPlaylistCoverResult>;
  remove: (playlistId: string) => Promise<void>;
}

export function playlistCoverUrl(playlistId: string, version: number): string {
  return `liner-local://playlist-cover/${encodeURIComponent(playlistId)}?v=${version}`;
}

/** Replaces the track-art collage with the custom cover, when one is set. */
export function withCustomCover<
  T extends { id: string; coverUrl: string; coverUrls: string[] },
>(playlist: T, versions: PlaylistCoverVersions): T {
  const version = versions[playlist.id];
  if (version === undefined) return playlist;
  const url = playlistCoverUrl(playlist.id, version);
  return { ...playlist, coverUrl: url, coverUrls: [url] };
}

export const usePlaylistCoverStore = create<PlaylistCoverState>((set, get) => ({
  versions: {},
  loaded: false,

  load: async () => {
    const bridge = window.linerElectron;
    if (get().loaded || !bridge?.playlistCoversList) return;
    set({ loaded: true });
    try {
      const versions = await bridge.playlistCoversList();
      set({ versions: { ...versions, ...get().versions } });
    } catch {
      set({ loaded: false });
    }
  },

  pick: async (playlistId) => {
    const bridge = window.linerElectron;
    if (!bridge?.playlistCoversPick) return "unreadable";
    const result = await bridge.playlistCoversPick(playlistId);
    if (result.status === "saved") {
      set({ versions: { ...get().versions, [playlistId]: result.version } });
    }
    return result.status;
  },

  remove: async (playlistId) => {
    if (get().versions[playlistId] === undefined) return;
    const { [playlistId]: _removed, ...rest } = get().versions;
    set({ versions: rest });
    await window.linerElectron
      ?.playlistCoversRemove?.(playlistId)
      .catch(() => {});
  },
}));
