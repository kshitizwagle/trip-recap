// QuickTime/MP4 metadata: creation dates, duration, dimensions and GPS (ISO 6709).

import {type ByteSource, fourCC, latin1, utf8Text, view} from "./bytes.ts";
import {type Box, childBoxes, findBox, topLevelBoxes} from "./isobmff.ts";
import type {ExifRecord} from "./tiff.ts";

const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800; // 1904-01-01 -> 1970-01-01
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

function macTime(seconds: number): string | undefined {
  if (!seconds) return undefined;
  const unix = seconds - MAC_EPOCH_OFFSET_SECONDS;
  if (unix <= 0) return undefined;
  return new Date(unix * 1000).toISOString().replace(".000Z", "Z");
}

interface HeaderTimes {
  created?: string;
  timescale?: number;
  duration?: number;
}

/** mvhd / mdhd share a layout: version, flags, creation, modification, timescale, duration. */
function readHeaderTimes(bytes: Uint8Array, box: Box): HeaderTimes {
  const dv = view(bytes);
  const version = bytes[box.start];
  if (version === 1) {
    return {
      created: macTime(Number(dv.getBigUint64(box.start + 4))),
      timescale: dv.getUint32(box.start + 20),
      duration: Number(dv.getBigUint64(box.start + 24)),
    };
  }
  return {
    created: macTime(dv.getUint32(box.start + 4)),
    timescale: dv.getUint32(box.start + 12),
    duration: dv.getUint32(box.start + 16),
  };
}

function readTkhd(bytes: Uint8Array, box: Box): {created?: string; width: number; height: number} {
  const dv = view(bytes);
  const version = bytes[box.start];
  const created = version === 1 ? macTime(Number(dv.getBigUint64(box.start + 4))) : macTime(dv.getUint32(box.start + 4));
  const sizeAt = box.end - 8;
  return {created, width: dv.getUint32(sizeAt) / 65536, height: dv.getUint32(sizeAt + 4) / 65536};
}

/** "+27.6588+085.3247+1300.000/" -> lat, lon, altitude */
export function parseIso6709(value: string): {latitude: number; longitude: number; altitude?: number} | null {
  const match = value.trim().match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const altitude = match[3] !== undefined ? Number(match[3]) : undefined;
  return {latitude, longitude, altitude: Number.isFinite(altitude) ? altitude : undefined};
}

/** Apple-style `meta` (hdlr + keys + ilst). The box may or may not carry version/flags. */
function readKeyedMeta(bytes: Uint8Array, meta: Box): Record<string, string> {
  const fullBox = fourCC(bytes, meta.start + 4) !== "hdlr";
  const start = meta.start + (fullBox ? 4 : 0);
  const boxes = childBoxes(bytes, start, meta.end);
  const keysBox = boxes.find((box) => box.type === "keys");
  const ilst = boxes.find((box) => box.type === "ilst");
  const values: Record<string, string> = {};
  if (!keysBox || !ilst) return values;

  const dv = view(bytes);
  const keys: string[] = [];
  const count = dv.getUint32(keysBox.start + 4);
  let at = keysBox.start + 8;
  for (let i = 0; i < count && at + 8 <= keysBox.end; i += 1) {
    const size = dv.getUint32(at);
    if (size < 8) break;
    keys.push(latin1(bytes.subarray(at + 8, at + size)));
    at += size;
  }

  for (const item of childBoxes(bytes, ilst.start, ilst.end)) {
    const index = dv.getUint32(item.start - 4) - 1;
    const key = keys[index];
    const data = childBoxes(bytes, item.start, item.end).find((box) => box.type === "data");
    if (!key || !data) continue;
    values[key] = utf8Text(bytes.subarray(data.start + 8, data.end));
  }
  return values;
}

/** Classic `©xyz` user-data atom: 2-byte length, 2-byte language, text. */
function readXyz(bytes: Uint8Array, box: Box): string {
  const length = view(bytes).getUint16(box.start);
  return latin1(bytes.subarray(box.start + 4, Math.min(box.end, box.start + 4 + length)));
}

export async function readQuickTime(source: ByteSource): Promise<ExifRecord> {
  const moovBox = (await topLevelBoxes(source)).find((box) => box.type === "moov");
  if (!moovBox) return {};
  const length = moovBox.end - moovBox.start;
  if (length > MAX_MOOV_BYTES) return {};
  const bytes = await source.read(moovBox.start, length);
  const record: ExifRecord = {};

  const mvhd = findBox(bytes, ["mvhd"]);
  if (mvhd) {
    const header = readHeaderTimes(bytes, mvhd);
    if (header.created) record.CreateDate = header.created;
    if (header.timescale && header.duration) record.Duration = header.duration / header.timescale;
  }

  for (const trak of childBoxes(bytes).filter((box) => box.type === "trak")) {
    const tkhd = findBox(bytes, ["tkhd"], trak.start, trak.end);
    const mdhd = findBox(bytes, ["mdia", "mdhd"], trak.start, trak.end);
    if (tkhd) {
      const info = readTkhd(bytes, tkhd);
      if (record.TrackCreateDate === undefined && info.created) record.TrackCreateDate = info.created;
      if (record.ImageWidth === undefined && info.width > 0 && info.height > 0) {
        record.ImageWidth = Math.round(info.width);
        record.ImageHeight = Math.round(info.height);
      }
    }
    if (mdhd && record.MediaCreateDate === undefined) {
      const created = readHeaderTimes(bytes, mdhd).created;
      if (created) record.MediaCreateDate = created;
    }
  }

  let location: string | undefined;
  const metas = [findBox(bytes, ["meta"]), findBox(bytes, ["udta", "meta"])].filter((box): box is Box => box !== null);
  for (const meta of metas) {
    const keyed = readKeyedMeta(bytes, meta);
    location ??= keyed["com.apple.quicktime.location.ISO6709"];
  }
  const udta = findBox(bytes, ["udta"]);
  if (!location && udta) {
    const xyz = childBoxes(bytes, udta.start, udta.end).find((box) => box.type === "©xyz");
    if (xyz) location = readXyz(bytes, xyz);
  }
  const parsed = location ? parseIso6709(location) : null;
  if (parsed) {
    record.GPSLatitude = parsed.latitude;
    record.GPSLongitude = parsed.longitude;
    if (parsed.altitude !== undefined) record.GPSAltitude = parsed.altitude;
  }
  return record;
}
