import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaylistCoverStore, isPlaylistCoverId } from "./store";

describe("PlaylistCoverStore", () => {
  let root: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "liner-covers-"));
    root = path.join(base, "playlist-covers");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("lists nothing before the folder exists", async () => {
    expect(await new PlaylistCoverStore(root).list()).toEqual({});
  });

  it("saves a cover, lists its version and locates the file", async () => {
    const store = new PlaylistCoverStore(root);
    const version = await store.set("pl_123", new Uint8Array([1, 2, 3]));

    expect(await store.list()).toEqual({ pl_123: version });
    const located = await store.locate("pl_123");
    expect(located).toEqual({
      path: path.join(root, "pl_123.jpg"),
      mimeType: "image/jpeg",
    });
    expect([...(await fs.readFile(located!.path))]).toEqual([1, 2, 3]);
  });

  it("replaces the previous cover for the same playlist", async () => {
    const store = new PlaylistCoverStore(root);
    await store.set("pl_123", new Uint8Array([1]));
    await store.set("pl_123", new Uint8Array([9, 9]));

    expect(Object.keys(await store.list())).toEqual(["pl_123"]);
    expect([...(await fs.readFile(path.join(root, "pl_123.jpg")))]).toEqual([
      9, 9,
    ]);
  });

  it("removes a cover", async () => {
    const store = new PlaylistCoverStore(root);
    await store.set("pl_123", new Uint8Array([1]));

    expect(await store.remove("pl_123")).toBe(true);
    expect(await store.remove("pl_123")).toBe(false);
    expect(await store.list()).toEqual({});
    expect(await store.locate("pl_123")).toBeNull();
  });

  it("refuses ids that could leave the folder", async () => {
    const store = new PlaylistCoverStore(root);
    for (const id of ["../evil", "a/b", "a\\b", "", "x".repeat(129)]) {
      expect(isPlaylistCoverId(id)).toBe(false);
      await expect(store.set(id, new Uint8Array([1]))).rejects.toThrow();
      expect(await store.locate(id)).toBeNull();
      expect(await store.remove(id)).toBe(false);
    }
  });

  it("ignores stray files in the folder", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "hi");
    await fs.writeFile(path.join(root, "bad name.jpg"), "hi");
    expect(await new PlaylistCoverStore(root).list()).toEqual({});
  });
});
