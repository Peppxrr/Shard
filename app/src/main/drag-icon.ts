import { nativeImage, type NativeImage } from "electron";

// Electron's Windows drag image is a Chromium LabelButton capped at 150 DIP,
// with 6 DIP insets on either side. Fill its image area so the filename label
// gets no space and the native center hotspot also centers the thumbnail.
const DRAG_IMAGE_WIDTH = 138;
const DRAG_IMAGE_MAX_HEIGHT = 90;

export function clipDragIcon(thumbnail: NativeImage): NativeImage {
  const size = thumbnail.getSize();
  if (thumbnail.isEmpty() || size.width <= 0 || size.height <= 0) return nativeImage.createEmpty();
  const scale = Math.min(1, DRAG_IMAGE_WIDTH / size.width, DRAG_IMAGE_MAX_HEIGHT / size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const resized = thumbnail.resize({ width, height, quality: "best" });
  const pixels = resized.toBitmap({ scaleFactor: 1 });
  const canvas = Buffer.alloc(DRAG_IMAGE_WIDTH * height * 4);
  const left = Math.floor((DRAG_IMAGE_WIDTH - width) / 2);
  for (let y = 0; y < height; y++) {
    pixels.copy(canvas, (y * DRAG_IMAGE_WIDTH + left) * 4, y * width * 4, (y + 1) * width * 4);
  }
  return nativeImage.createFromBitmap(canvas, { width: DRAG_IMAGE_WIDTH, height, scaleFactor: 1 });
}
