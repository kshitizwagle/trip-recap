// Locate the EXIF TIFF block in JPEG, PNG, WebP and HEIC/HEIF files.

import {type ByteSource, fourCC, startsWith, view} from "./bytes.ts";
import {childBoxes, findBox, topLevelBoxes} from "./isobmff.ts";

const EXIF_MARKER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function stripExifPrefix(bytes: Uint8Array): Uint8Array {
  return startsWith(bytes, EXIF_MARKER) ? bytes.subarray(6) : bytes;
}

async function jpegExif(source: ByteSource): Promise<Uint8Array | null> {
  let at = 2;
  while (at + 4 <= source.size) {
    const header = await source.read(at, 4);
    if (header[0] !== 0xff) return null;
    const marker = header[1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end of image
    const length = view(header).getUint16(2);
    if (marker === 0xe1) {
      const segment = await source.read(at + 4, length - 2);
      if (startsWith(segment, EXIF_MARKER)) return segment.subarray(6);
    }
    at += 2 + length;
  }
  return null;
}

async function pngExif(source: ByteSource): Promise<Uint8Array | null> {
  let at = 8;
  while (at + 12 <= source.size) {
    const header = await source.read(at, 8);
    const length = view(header).getUint32(0);
    const type = fourCC(header, 4);
    if (type === "eXIf") return stripExifPrefix(await source.read(at + 8, length));
    if (type === "IEND") return null;
    at += 12 + length;
  }
  return null;
}

async function webpExif(source: ByteSource): Promise<Uint8Array | null> {
  let at = 12;
  while (at + 8 <= source.size) {
    const header = await source.read(at, 8);
    const type = fourCC(header, 0);
    const length = view(header).getUint32(4, true);
    if (type === "EXIF") return stripExifPrefix(await source.read(at + 8, length));
    at += 8 + length + (length % 2);
  }
  return null;
}

interface IlocExtent {
  offset: number;
  length: number;
}

function readSized(dv: DataView, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return dv.getUint32(at);
  if (size === 8) return Number(dv.getBigUint64(at));
  if (size === 2) return dv.getUint16(at);
  return 0;
}

/** Parses an `iloc` box payload into item id -> extents. */
export function parseIloc(bytes: Uint8Array, start: number, end: number): Map<number, IlocExtent[]> {
  const dv = view(bytes);
  const items = new Map<number, IlocExtent[]>();
  const version = bytes[start];
  let at = start + 4;
  const sizes = dv.getUint16(at);
  at += 2;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = version === 1 || version === 2 ? sizes & 0xf : 0;
  const itemCount = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
  at += version < 2 ? 2 : 4;
  for (let i = 0; i < itemCount && at < end; i += 1) {
    const itemId = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
    at += version < 2 ? 2 : 4;
    if (version === 1 || version === 2) at += 2; // construction method
    at += 2; // data reference index
    const baseOffset = readSized(dv, at, baseOffsetSize);
    at += baseOffsetSize;
    const extentCount = dv.getUint16(at);
    at += 2;
    const extents: IlocExtent[] = [];
    for (let e = 0; e < extentCount; e += 1) {
      at += indexSize;
      const offset = readSized(dv, at, offsetSize);
      at += offsetSize;
      const length = readSized(dv, at, lengthSize);
      at += lengthSize;
      extents.push({offset: baseOffset + offset, length});
    }
    items.set(itemId, extents);
  }
  return items;
}

/** Finds item ids of a given type in an `iinf` box payload. */
export function itemIdsOfType(bytes: Uint8Array, start: number, end: number, itemType: string): number[] {
  const dv = view(bytes);
  const version = bytes[start];
  const entriesStart = start + 4 + (version === 0 ? 2 : 4);
  const ids: number[] = [];
  for (const box of childBoxes(bytes, entriesStart, end)) {
    if (box.type !== "infe") continue;
    const infeVersion = bytes[box.start];
    if (infeVersion < 2) continue;
    let at = box.start + 4;
    const itemId = infeVersion === 2 ? dv.getUint16(at) : dv.getUint32(at);
    at += infeVersion === 2 ? 2 : 4;
    at += 2; // protection index
    if (fourCC(bytes, at) === itemType) ids.push(itemId);
  }
  return ids;
}

async function heifExif(source: ByteSource): Promise<Uint8Array | null> {
  const meta = (await topLevelBoxes(source)).find((box) => box.type === "meta");
  if (!meta) return null;
  const bytes = await source.read(meta.start, meta.end - meta.start);
  const iinf = findBox(bytes, ["iinf"], 4);
  const iloc = findBox(bytes, ["iloc"], 4);
  if (!iinf || !iloc) return null;
  const [exifId] = itemIdsOfType(bytes, iinf.start, iinf.end, "Exif");
  if (exifId === undefined) return null;
  const extents = parseIloc(bytes, iloc.start, iloc.end).get(exifId);
  if (!extents?.length) return null;
  const parts = await Promise.all(extents.map((extent) => source.read(extent.offset, extent.length)));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  if (data.length < 4) return null;
  const tiffOffset = view(data).getUint32(0);
  return stripExifPrefix(data.subarray(4 + tiffOffset));
}

export async function findImageExif(source: ByteSource): Promise<Uint8Array | null> {
  const header = await source.read(0, 16);
  if (startsWith(header, [0xff, 0xd8])) return jpegExif(source);
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47])) return pngExif(source);
  if (fourCC(header, 0) === "RIFF" && fourCC(header, 8) === "WEBP") return webpExif(source);
  if (fourCC(header, 4) === "ftyp") return heifExif(source);
  return null;
}
