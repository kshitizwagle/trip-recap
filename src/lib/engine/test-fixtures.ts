// Builders for tiny synthetic media files used by the engine tests. No real user media is committed.

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array(Array.from(text, (char) => char.charCodeAt(0) & 0xff));
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(children);
  return concat([u32(payload.length + 8), ascii(type), payload]);
}

export function fullBox(type: string, version: number, ...children: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, 0, 0, 0]), ...children);
}

interface TiffOptions {
  dateTimeOriginal?: string;
  createDate?: string;
  offsetTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  littleEndian?: boolean;
}

function dms(value: number): Array<[number, number]> {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60 * 10000);
  return [[degrees, 1], [minutes, 1], [seconds, 10000]];
}

/** A TIFF block with IFD0 -> ExifIFD + GPS IFD, like a phone camera writes. */
export function buildTiff(options: TiffOptions): Uint8Array {
  const little = options.littleEndian ?? true;
  const buffer = new Uint8Array(4096);
  const dv = new DataView(buffer.buffer);
  const w16 = (at: number, value: number) => dv.setUint16(at, value, little);
  const w32 = (at: number, value: number) => dv.setUint32(at, value, little);
  buffer.set(ascii(little ? "II" : "MM"), 0);
  w16(2, 42);
  w32(4, 8);
  let heap = 1024;

  type Field = {tag: number; type: number; count: number; data?: Uint8Array; inline?: number};
  const writeIfd = (at: number, fields: Field[]) => {
    w16(at, fields.length);
    fields.forEach((field, index) => {
      const entry = at + 2 + index * 12;
      w16(entry, field.tag);
      w16(entry + 2, field.type);
      w32(entry + 4, field.count);
      if (field.data && field.data.length > 4) {
        buffer.set(field.data, heap);
        w32(entry + 8, heap);
        heap += field.data.length + (field.data.length % 2);
      } else if (field.data) {
        buffer.set(field.data, entry + 8);
      } else if (field.type === 3) {
        w16(entry + 8, field.inline ?? 0);
      } else {
        w32(entry + 8, field.inline ?? 0);
      }
    });
    w32(at + 2 + fields.length * 12, 0);
  };
  const asciiField = (tag: number, text: string): Field => ({tag, type: 2, count: text.length + 1, data: ascii(`${text}\0`)});
  const rationals = (values: Array<[number, number]>) => {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    values.forEach(([n, d], i) => {
      view.setUint32(i * 8, n, little);
      view.setUint32(i * 8 + 4, d, little);
    });
    return out;
  };

  const exifFields: Field[] = [];
  if (options.dateTimeOriginal) exifFields.push(asciiField(0x9003, options.dateTimeOriginal));
  if (options.createDate) exifFields.push(asciiField(0x9004, options.createDate));
  if (options.offsetTimeOriginal) exifFields.push(asciiField(0x9011, options.offsetTimeOriginal));
  const gpsFields: Field[] = [];
  if (options.latitude !== undefined && options.longitude !== undefined) {
    gpsFields.push({tag: 1, type: 2, count: 2, data: ascii(`${options.latitude < 0 ? "S" : "N"}\0`)});
    gpsFields.push({tag: 2, type: 5, count: 3, data: rationals(dms(options.latitude))});
    gpsFields.push({tag: 3, type: 2, count: 2, data: ascii(`${options.longitude < 0 ? "W" : "E"}\0`)});
    gpsFields.push({tag: 4, type: 5, count: 3, data: rationals(dms(options.longitude))});
  }
  if (options.altitude !== undefined) {
    gpsFields.push({tag: 5, type: 1, count: 1, data: new Uint8Array([options.altitude < 0 ? 1 : 0, 0, 0, 0])});
    gpsFields.push({tag: 6, type: 5, count: 1, data: rationals([[Math.round(Math.abs(options.altitude) * 10), 10]])});
  }

  const exifAt = 200;
  const gpsAt = 500;
  writeIfd(8, [
    {tag: 0x8769, type: 4, count: 1, inline: exifAt},
    {tag: 0x8825, type: 4, count: 1, inline: gpsAt},
  ]);
  writeIfd(exifAt, exifFields);
  writeIfd(gpsAt, gpsFields);
  return buffer.slice(0, heap);
}

export function buildJpeg(tiff: Uint8Array): Uint8Array {
  const app1 = concat([ascii("Exif\0\0"), tiff]);
  return concat([
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe0]), u16(16), ascii("JFIF\0"), new Uint8Array(9),
    new Uint8Array([0xff, 0xe1]), u16(app1.length + 2), app1,
    new Uint8Array([0xff, 0xda, 0x00, 0x02]),
    new Uint8Array([0xff, 0xd9]),
  ]);
}

export function buildHeic(tiff: Uint8Array): Uint8Array {
  const exifPayload = concat([u32(6), ascii("Exif\0\0"), tiff]);
  const ftyp = box("ftyp", ascii("heic"), u32(0), ascii("mif1heic"));
  const infe = (id: number, type: string) => fullBox("infe", 2, u16(id), u16(0), ascii(type), ascii("\0"));
  const iinf = fullBox("iinf", 0, u16(2), infe(1, "hvc1"), infe(2, "Exif"));
  // iloc v0: offset_size=4, length_size=4, base_offset_size=0; offset patched after layout.
  const ilocFor = (offset: number) =>
    fullBox("iloc", 0, u16(0x4400), u16(1), u16(2), u16(0), u16(1), u32(offset), u32(exifPayload.length));
  const metaFor = (offset: number) => fullBox("meta", 0, fullBox("hdlr", 0, u32(0), ascii("pict"), new Uint8Array(13)), iinf, ilocFor(offset));
  const provisional = metaFor(0);
  const mdatHeader = 8;
  const exifOffset = ftyp.length + provisional.length + mdatHeader;
  return concat([ftyp, metaFor(exifOffset), box("mdat", exifPayload)]);
}

const MAC_EPOCH = 2_082_844_800;

interface Mp4Options {
  createdUnix?: number;
  mediaCreatedUnix?: number;
  durationSeconds?: number;
  xyz?: string;
  appleLocation?: string;
  mdatBytes?: number;
}

export function buildMp4(options: Mp4Options): Uint8Array {
  const mac = (unix?: number) => (unix ? unix + MAC_EPOCH : 0);
  const timescale = 600;
  const mvhd = fullBox("mvhd", 0, u32(mac(options.createdUnix)), u32(mac(options.createdUnix)), u32(timescale), u32(Math.round((options.durationSeconds ?? 0) * timescale)), new Uint8Array(80));
  const tkhd = fullBox("tkhd", 0, u32(mac(options.createdUnix)), u32(mac(options.createdUnix)), u32(1), u32(0), u32(0), new Uint8Array(52), u32(1920 * 65536), u32(1080 * 65536));
  const mdhd = fullBox("mdhd", 0, u32(mac(options.mediaCreatedUnix)), u32(mac(options.mediaCreatedUnix)), u32(timescale), u32(0), u16(0), u16(0));
  const trak = box("trak", tkhd, box("mdia", mdhd));
  const children = [mvhd, trak];
  if (options.xyz) {
    const text = ascii(options.xyz);
    children.push(box("udta", box("©xyz", u16(text.length), u16(0x15c7), text)));
  }
  if (options.appleLocation) {
    const key = ascii("com.apple.quicktime.location.ISO6709");
    const keys = fullBox("keys", 0, u32(1), u32(key.length + 8), ascii("mdta"), key);
    const value = new TextEncoder().encode(options.appleLocation);
    const ilst = box("ilst", concat([u32(8 + 8 + 8 + value.length), u32(1), box("data", u32(1), u32(0), value)]));
    children.push(box("meta", box("hdlr", u32(0), u32(0), ascii("mdta"), new Uint8Array(13)), keys, ilst));
  }
  return concat([box("ftyp", ascii("qt  "), u32(0), ascii("qt  ")), box("mdat", new Uint8Array(options.mdatBytes ?? 32)), box("moov", ...children)]);
}
