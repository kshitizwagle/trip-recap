// Minimal TIFF/EXIF reader for the tags Trip Recap uses (names follow ExifTool).

import {latin1} from "./bytes.ts";

export type ExifRecord = Record<string, string | number | undefined>;

const TYPE_SIZES: Record<number, number> = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8};

const IFD0_TAGS: Record<number, string> = {
  0x0100: "ImageWidth",
  0x0101: "ImageHeight",
  0x0132: "ModifyDate",
};
const EXIF_TAGS: Record<number, string> = {
  0x9003: "DateTimeOriginal",
  0x9004: "CreateDate",
  0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal",
  0x9012: "OffsetTimeDigitized",
  0xa002: "ExifImageWidth",
  0xa003: "ExifImageHeight",
};

interface Entry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
}

class TiffReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly little: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[0], bytes[1]);
    if (order !== "II" && order !== "MM") throw new Error("not a TIFF header");
    this.little = order === "II";
    if (this.u16(2) !== 42) throw new Error("bad TIFF magic");
  }

  u16(offset: number) { return this.view.getUint16(offset, this.little); }
  u32(offset: number) { return this.view.getUint32(offset, this.little); }
  i32(offset: number) { return this.view.getInt32(offset, this.little); }

  firstIfd(): number { return this.u32(4); }

  entries(ifdOffset: number): Entry[] {
    if (ifdOffset <= 0 || ifdOffset + 2 > this.bytes.length) return [];
    const count = this.u16(ifdOffset);
    const result: Entry[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = ifdOffset + 2 + i * 12;
      if (at + 12 > this.bytes.length) break;
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      const size = (TYPE_SIZES[type] ?? 1) * n;
      result.push({tag: this.u16(at), type, count: n, valueOffset: size <= 4 ? at + 8 : this.u32(at + 8)});
    }
    return result;
  }

  value(entry: Entry): string | number | number[] | undefined {
    const {type, count, valueOffset: at} = entry;
    const size = (TYPE_SIZES[type] ?? 1) * count;
    if (at < 0 || at + size > this.bytes.length) return undefined;
    switch (type) {
      case 2:
        return latin1(this.bytes.subarray(at, at + count)).trim();
      case 1:
      case 7:
        return count === 1 ? this.bytes[at] : Array.from(this.bytes.subarray(at, at + count));
      case 3: {
        const values = Array.from({length: count}, (_, i) => this.u16(at + i * 2));
        return count === 1 ? values[0] : values;
      }
      case 4:
      case 9: {
        const values = Array.from({length: count}, (_, i) => (type === 4 ? this.u32(at + i * 4) : this.i32(at + i * 4)));
        return count === 1 ? values[0] : values;
      }
      case 5:
      case 10: {
        const values = Array.from({length: count}, (_, i) => {
          const numerator = type === 5 ? this.u32(at + i * 8) : this.i32(at + i * 8);
          const denominator = type === 5 ? this.u32(at + i * 8 + 4) : this.i32(at + i * 8 + 4);
          return denominator === 0 ? NaN : numerator / denominator;
        });
        return count === 1 ? values[0] : values;
      }
      default:
        return undefined;
    }
  }
}

function dmsToDecimal(value: unknown, ref: unknown, negativeRef: string): number | undefined {
  const parts = Array.isArray(value) ? value : typeof value === "number" ? [value] : null;
  if (!parts || !parts.length || parts.some((part) => typeof part !== "number" || !Number.isFinite(part))) return undefined;
  const [degrees = 0, minutes = 0, seconds = 0] = parts as number[];
  const decimal = degrees + minutes / 60 + seconds / 3600;
  return typeof ref === "string" && ref.trim().toUpperCase().startsWith(negativeRef) ? -decimal : decimal;
}

/** Parses a TIFF block (as found after the "Exif\0\0" marker) into ExifTool-style fields. */
export function parseTiff(bytes: Uint8Array): ExifRecord {
  const reader = new TiffReader(bytes);
  const record: ExifRecord = {};
  let exifIfd = 0;
  let gpsIfd = 0;

  for (const entry of reader.entries(reader.firstIfd())) {
    if (entry.tag === 0x8769) exifIfd = Number(reader.value(entry));
    else if (entry.tag === 0x8825) gpsIfd = Number(reader.value(entry));
    else if (IFD0_TAGS[entry.tag]) {
      const value = reader.value(entry);
      if (typeof value === "number" || typeof value === "string") record[IFD0_TAGS[entry.tag]] = value;
    }
  }

  for (const entry of reader.entries(exifIfd)) {
    const name = EXIF_TAGS[entry.tag];
    if (!name) continue;
    const value = reader.value(entry);
    if (typeof value === "number" || typeof value === "string") record[name] = value;
  }

  const gps: Record<number, unknown> = {};
  for (const entry of reader.entries(gpsIfd)) gps[entry.tag] = reader.value(entry);
  const latitude = dmsToDecimal(gps[2], gps[1], "S");
  const longitude = dmsToDecimal(gps[4], gps[3], "W");
  if (latitude !== undefined) record.GPSLatitude = latitude;
  if (longitude !== undefined) record.GPSLongitude = longitude;
  if (typeof gps[6] === "number" && Number.isFinite(gps[6])) {
    record.GPSAltitude = gps[5] === 1 ? -(gps[6] as number) : (gps[6] as number);
  }
  if (typeof gps[0x11] === "number" && Number.isFinite(gps[0x11])) record.GPSImgDirection = gps[0x11] as number;
  if (typeof gps[0x18] === "number" && Number.isFinite(gps[0x18])) record.GPSDestBearing = gps[0x18] as number;
  if (record.ImageWidth === undefined && record.ExifImageWidth !== undefined) record.ImageWidth = record.ExifImageWidth;
  if (record.ImageHeight === undefined && record.ExifImageHeight !== undefined) record.ImageHeight = record.ExifImageHeight;
  return record;
}
