import { describe, expect, it } from "vitest";
import { playlistCoverUrl, withCustomCover } from "./playlistCoverStore";

const playlist = {
  id: "pl_1",
  title: "Road trip",
  coverUrl: "https://example.com/a.jpg",
  coverUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
};

describe("withCustomCover", () => {
  it("keeps the track-art collage when no custom cover is set", () => {
    expect(withCustomCover(playlist, {})).toBe(playlist);
    expect(withCustomCover(playlist, { other: 5 })).toBe(playlist);
  });

  it("swaps the collage for the custom cover", () => {
    const shown = withCustomCover(playlist, { pl_1: 42 });
    const url = "liner-local://playlist-cover/pl_1?v=42";
    expect(shown).toEqual({ ...playlist, coverUrl: url, coverUrls: [url] });
    expect(playlist.coverUrls).toHaveLength(2);
  });
});

describe("playlistCoverUrl", () => {
  it("changes with the version so a new pick is not served from cache", () => {
    expect(playlistCoverUrl("pl_1", 1)).not.toBe(playlistCoverUrl("pl_1", 2));
  });
});
