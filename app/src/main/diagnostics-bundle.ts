// One-click diagnostics bundle for testers: a single .zip with the core and
// libobs log (from the developer-console session log), the perf.stats
// timeline, recent clips' lag markers and a system/settings summary.
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);
// Bounds a single member; session logs are pruned well below this.
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

export interface BundleMember {
  name: string; // forward-slash path inside the zip
  data: Buffer;
}

export interface BundleSources {
  systemInfo: unknown;
  recentClips: unknown;
  devConsole: { current: { path: string; bytes: number } | null; prior: string[] };
  perf: { current: string | null; prior: string[] };
}

async function readBounded(file: string, bytes?: number): Promise<Buffer | null> {
  try {
    const size = bytes ?? (await fs.stat(file)).size;
    if (size <= 0) return Buffer.alloc(0);
    const length = Math.min(size, MAX_MEMBER_BYTES);
    // Keep the newest part of oversized logs.
    const start = size - length;
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(file, { start, end: size - 1 })) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// Developer-console JSONL -> readable "time level text" lines.
function readableLog(jsonl: Buffer): Buffer {
  const lines: string[] = [];
  for (const raw of jsonl.toString("utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as { t?: number; level?: string; severity?: string; text?: string };
      const time = typeof line.t === "number" ? new Date(line.t).toISOString() : "?";
      lines.push(`${time} ${line.level ?? "?"}${line.severity ? `/${line.severity}` : ""} ${line.text ?? ""}`);
    } catch {
      lines.push(raw);
    }
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

const README = `Shard diagnostics bundle

system-info.json            App, OS, CPU, GPU, displays, capture/video settings,
                            Recording priority state and the core's session
                            diagnostics (elevation, GPU priority, HAGS, driver,
                            capture method, hook status, encoder and settings,
                            base/output resolution, FPS).
logs/core-current.log       Readable log of this app session, including every
                            core and libobs line ([obs], [perf], [perf-session],
                            [capture-method], [capture-health], [encoder]).
logs/*.jsonl                The same logs as recorded (current and previous sessions).
perf/*.jsonl                perf.stats samples, one per second: rendered/lagged
                            frames (render lag), encoder-skipped frames, frame
                            time, GPU 3D/VideoEncode utilization and the cause.
clips/recent-clips.json     Recent clips and recordings with their lag markers.

Nothing in this bundle is uploaded automatically.
`;

export async function collectBundleMembers(sources: BundleSources): Promise<BundleMember[]> {
  const members: BundleMember[] = [
    { name: "README.txt", data: Buffer.from(README, "utf8") },
    { name: "system-info.json", data: Buffer.from(JSON.stringify(sources.systemInfo, null, 2), "utf8") },
    { name: "clips/recent-clips.json", data: Buffer.from(JSON.stringify(sources.recentClips, null, 2), "utf8") },
  ];
  const current = sources.devConsole.current;
  if (current) {
    const data = await readBounded(current.path, current.bytes);
    if (data) {
      members.push({ name: "logs/core-current.log", data: readableLog(data) });
      members.push({ name: "logs/developer-console-current.jsonl", data });
    }
  }
  for (const [index, file] of sources.devConsole.prior.slice(0, 2).entries()) {
    const data = await readBounded(file);
    if (data) members.push({ name: `logs/developer-console-previous-${index + 1}.jsonl`, data });
  }
  if (sources.perf.current) {
    const data = await readBounded(sources.perf.current);
    if (data) members.push({ name: "perf/perf-current.jsonl", data });
  }
  for (const [index, file] of sources.perf.prior.slice(0, 2).entries()) {
    const data = await readBounded(file);
    if (data) members.push({ name: `perf/perf-previous-${index + 1}.jsonl`, data });
  }
  return members;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Minimal deflate ZIP (no ZIP64: members are bounded well below 4 GiB).
export async function zipMembers(members: BundleMember[], now = new Date()): Promise<Buffer> {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const compressed = await deflate(member.data);
    const checksum = crc32(member.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Writes through a temporary sibling so a failed export never leaves a
// truncated bundle at the chosen path.
export async function writeBundle(destination: string, members: BundleMember[]): Promise<void> {
  const target = resolve(destination);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, await zipMembers(members), { flag: "wx" });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
