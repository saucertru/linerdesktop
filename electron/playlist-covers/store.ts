import fsp from "node:fs/promises";
import path from "node:path";

// playlist ids come from the api; anything else never touches the disk
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXTENSION = ".jpg";

/** Playlist id → version (file mtime), used by the renderer to bust the image cache. */
export type PlaylistCoverVersions = Record<string, number>;

export function isPlaylistCoverId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * Custom playlist covers picked on this device. One JPEG per playlist,
 * `<root>/<playlistId>.jpg`. They are not uploaded anywhere.
 */
export class PlaylistCoverStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private filePath(id: string) {
    return path.join(this.root, `${id}${EXTENSION}`);
  }

  async list(): Promise<PlaylistCoverVersions> {
    const versions: PlaylistCoverVersions = {};
    let names: string[];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return versions;
    }
    for (const name of names) {
      if (!name.endsWith(EXTENSION)) continue;
      const id = name.slice(0, -EXTENSION.length);
      if (!isPlaylistCoverId(id)) continue;
      try {
        versions[id] = Math.round((await fsp.stat(this.filePath(id))).mtimeMs);
      } catch {}
    }
    return versions;
  }

  /** Writes the already encoded JPEG and returns its new version. */
  set(id: string, jpeg: Uint8Array): Promise<number> {
    if (!isPlaylistCoverId(id)) {
      return Promise.reject(new Error(`invalid playlist id ${String(id)}`));
    }
    return this.serialized(async () => {
      await fsp.mkdir(this.root, { recursive: true });
      const target = this.filePath(id);
      const temp = `${target}.tmp`;
      await fsp.writeFile(temp, jpeg);
      await fsp.rename(temp, target);
      return Math.round((await fsp.stat(target)).mtimeMs);
    });
  }

  remove(id: string): Promise<boolean> {
    if (!isPlaylistCoverId(id)) return Promise.resolve(false);
    return this.serialized(async () => {
      try {
        await fsp.unlink(this.filePath(id));
        return true;
      } catch {
        return false;
      }
    });
  }

  async locate(id: string): Promise<{ path: string; mimeType: string } | null> {
    if (!isPlaylistCoverId(id)) return null;
    const filePath = this.filePath(id);
    try {
      await fsp.access(filePath);
      return { path: filePath, mimeType: "image/jpeg" };
    } catch {
      return null;
    }
  }
}
