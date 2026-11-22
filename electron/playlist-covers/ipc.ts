import path from "node:path";
import { BrowserWindow, app, dialog, nativeImage } from "electron";
import { handleTrusted } from "../ipc-guard.js";
import { PlaylistCoverStore, isPlaylistCoverId } from "./store.js";

export const PLAYLIST_COVER_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];

// covers render at 140px in the hero; 600px stays sharp on 4x screens
const COVER_SIZE = 600;
const JPEG_QUALITY = 88;

export type PlaylistCoverPickResult =
  | { status: "saved"; version: number }
  | { status: "canceled" }
  | { status: "unreadable" };

/** Center-crops to a square and scales down to COVER_SIZE, then encodes JPEG. */
function encodeCover(filePath: string): Buffer | null {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  if (side <= 0) return null;
  const square = image.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side,
  });
  const scaled =
    side > COVER_SIZE
      ? square.resize({
          width: COVER_SIZE,
          height: COVER_SIZE,
          quality: "best",
        })
      : square;
  const jpeg = scaled.toJPEG(JPEG_QUALITY);
  return jpeg.length > 0 ? jpeg : null;
}

export function setupPlaylistCovers(): PlaylistCoverStore {
  const store = new PlaylistCoverStore(
    path.join(app.getPath("userData"), "playlist-covers"),
  );

  handleTrusted("playlist-covers:list", () => store.list());

  handleTrusted(
    "playlist-covers:pick",
    async (event, id: unknown): Promise<PlaylistCoverPickResult> => {
      if (!isPlaylistCoverId(id)) return { status: "unreadable" };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: PLAYLIST_COVER_EXTENSIONS }],
      };
      const picked = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      const filePath = picked.filePaths[0];
      if (picked.canceled || !filePath) return { status: "canceled" };
      const jpeg = encodeCover(filePath);
      if (!jpeg) return { status: "unreadable" };
      const version = await store.set(id, jpeg);
      return { status: "saved", version };
    },
  );

  handleTrusted("playlist-covers:remove", (_event, id: unknown) =>
    isPlaylistCoverId(id) ? store.remove(id) : false,
  );

  return store;
}
