import type { WaveformData } from "../shared/contracts";

export interface WaveformStorage {
  get(key: string): Buffer | undefined;
  put(key: string, data: Buffer): void;
}

// WF01: magic, uint32 point count, float64 duration, then little-endian uint16
// normalized peaks. 2400 bins occupy 4816 bytes, with no raw PCM persisted.
export function encodeWaveform(waveform: WaveformData): Buffer {
  const output = Buffer.alloc(16 + waveform.peaks.length * 2);
  output.write("WF01", 0, "ascii");
  output.writeUInt32LE(waveform.peaks.length, 4);
  output.writeDoubleLE(waveform.duration, 8);
  waveform.peaks.forEach((peak, index) => output.writeUInt16LE(Math.round(Math.max(0, Math.min(1, peak)) * 65535), 16 + index * 2));
  return output;
}

export function decodeWaveform(data: Buffer): WaveformData | undefined {
  if (data.length < 16 || data.toString("ascii", 0, 4) !== "WF01") return;
  const count = data.readUInt32LE(4);
  const duration = data.readDoubleLE(8);
  if (count < 128 || count > 8000 || data.length !== 16 + count * 2 || !Number.isFinite(duration) || duration <= 0) return;
  return { duration, peaks: Array.from({ length: count }, (_, index) => data.readUInt16LE(16 + index * 2) / 65535) };
}
