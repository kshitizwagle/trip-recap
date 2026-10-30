// ISO base media (MP4/MOV/HEIC) box helpers.

import {type ByteSource, fourCC, view} from "./bytes.ts";

export interface Box {
  type: string;
  /** Offset of the payload (after the header) within the parent buffer or file. */
  start: number;
  /** Offset just past the end of the box. */
  end: number;
}

/** Child boxes inside an in-memory buffer range. */
export function childBoxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const boxes: Box[] = [];
  const dv = view(bytes);
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    const type = fourCC(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(dv.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({type, start: at + header, end: at + size});
    at += size;
  }
  return boxes;
}

export function findBox(bytes: Uint8Array, path: string[], start = 0, end = bytes.length): Box | null {
  let range: Box | null = {type: "", start, end};
  for (const type of path) {
    const current: Box = range;
    range = childBoxes(bytes, current.start, current.end).find((box) => box.type === type) ?? null;
    if (!range) return null;
  }
  return range;
}

/** Top-level boxes in a file, reading only their headers. */
export async function topLevelBoxes(source: ByteSource, limit = 64): Promise<Box[]> {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= source.size && boxes.length < limit) {
    const header = await source.read(at, 16);
    if (header.length < 8) break;
    const dv = view(header);
    let size = dv.getUint32(0);
    const type = fourCC(header, 4);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) break;
      size = Number(dv.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = source.size - at;
    }
    if (size < headerSize) break;
    boxes.push({type, start: at + headerSize, end: Math.min(at + size, source.size)});
    at += size;
  }
  return boxes;
}

export function isIsoBmff(header: Uint8Array): boolean {
  return header.length >= 12 && fourCC(header, 4) === "ftyp";
}

export function majorBrand(header: Uint8Array): string {
  return header.length >= 12 ? fourCC(header, 8) : "";
}
