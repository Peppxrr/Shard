// Dev-only media protocol.
//
// The Vite renderer runs on an HTTP origin, where Chromium refuses to load
// clip files from file:// (the packaged renderer is file:// and needs no
// bridge). Serve local media through this scheme during development with
// byte-range support so the viewer, editor seeks, and thumbnails behave like
// the packaged build.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";

export const DEV_MEDIA_SCHEME = "shard-media";

const MEDIA_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export function registerDevMediaProtocol(): void {
  protocol.handle(DEV_MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "media") return new Response("Not found", { status: 404 });
    const requested = url.searchParams.get("path");
    if (!requested || requested.includes("\0") || !path.isAbsolute(requested)) {
      return new Response("Invalid media path", { status: 400 });
    }
    const mime = MEDIA_MIME[path.extname(requested).toLowerCase()];
    if (!mime) return new Response("Unsupported media type", { status: 404 });

    let size: number;
    try {
      const info = await stat(requested);
      if (!info.isFile()) return new Response("Not found", { status: 404 });
      size = info.size;
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (request.method === "HEAD") {
      return new Response(null, { headers: { ...headers, "Content-Length": String(size) } });
    }

    const range = request.headers.get("range");
    if (!range) {
      return new Response(Readable.toWeb(createReadStream(requested)), {
        headers: { ...headers, "Content-Length": String(size) },
      });
    }

    const bytes = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = bytes?.[1] ? Number(bytes[1]) : 0;
    let end = bytes?.[2] ? Number(bytes[2]) : size - 1;
    // A suffix range ("bytes=-500") selects the final N bytes.
    if (bytes && !bytes[1] && bytes[2]) {
      start = Math.max(0, size - Number(bytes[2]));
      end = size - 1;
    }
    if (!bytes || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }
    end = Math.min(end, size - 1);
    return new Response(Readable.toWeb(createReadStream(requested, { start, end })), {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  });
}
