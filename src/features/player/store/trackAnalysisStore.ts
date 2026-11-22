import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TrackAnalysis } from "../engine/audioAnalysis";

// Tempo and silence bounds per track: a handful of numbers each, so they are kept
// between launches. Waveforms are larger and stay in memory (see trackAnalyzer).

const MAX_ENTRIES = 600;

interface StoredAnalysis extends TrackAnalysis {
  analyzedAt: number;
}

interface TrackAnalysisState {
  byTrack: Record<string, StoredAnalysis>;
  put: (trackId: string, analysis: TrackAnalysis) => void;
}

export const TRACK_ANALYSIS_STORAGE_KEY = "liner_track_analysis_v1";

function isAnalysis(value: unknown): value is StoredAnalysis {
  if (!value || typeof value !== "object") return false;
  const v = value as StoredAnalysis;
  return (
    (v.bpm === null || (typeof v.bpm === "number" && Number.isFinite(v.bpm))) &&
    Number.isFinite(v.firstAudibleMs) &&
    Number.isFinite(v.lastAudibleMs) &&
    Number.isFinite(v.durationMs) &&
    Number.isFinite(v.analyzedAt)
  );
}

export const useTrackAnalysisStore = create<TrackAnalysisState>()(
  persist(
    (set, get) => ({
      byTrack: {},
      put: (trackId, analysis) => {
        const next = {
          ...get().byTrack,
          [trackId]: { ...analysis, analyzedAt: Date.now() },
        };
        const ids = Object.keys(next);
        if (ids.length > MAX_ENTRIES) {
          ids
            .sort((a, b) => next[a].analyzedAt - next[b].analyzedAt)
            .slice(0, ids.length - MAX_ENTRIES)
            .forEach((id) => delete next[id]);
        }
        set({ byTrack: next });
      },
    }),
    {
      name: TRACK_ANALYSIS_STORAGE_KEY,
      version: 1,
      partialize: (state) => ({ byTrack: state.byTrack }),
      merge: (persisted, current) => {
        const byTrack: Record<string, StoredAnalysis> = {};
        const raw = (persisted as { byTrack?: unknown } | undefined)?.byTrack;
        if (raw && typeof raw === "object") {
          for (const [id, value] of Object.entries(raw)) {
            if (isAnalysis(value)) byTrack[id] = value;
          }
        }
        return { ...current, byTrack };
      },
    },
  ),
);

export function getTrackAnalysis(trackId: string): TrackAnalysis | null {
  return useTrackAnalysisStore.getState().byTrack[trackId] ?? null;
}
