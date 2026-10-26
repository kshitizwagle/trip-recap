// Port of backend/app/metadata/extractor.py, reading files in the browser instead of ExifTool.

import {uuid5} from "../ids.ts";
import type {GPSQuality, MediaPoint, MediaType} from "../models.ts";
import {type ByteSource, blobSource} from "./bytes.ts";
import {findImageExif} from "./images.ts";
import {readQuickTime} from "./quicktime.ts";
import {type ExifRecord, parseTiff} from "./tiff.ts";

export const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);
export const SUPPORTED_EXTENSIONS = new Set([...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const PHOTO_TIMESTAMP_FIELDS = ["DateTimeOriginal", "CreateDate", "MediaCreateDate"] as const;
const VIDEO_TIMESTAMP_FIELDS = ["MediaCreateDate", "TrackCreateDate", "CreateDate"] as const;
const OFFSET_FIELDS: Record<string, string> = {
  DateTimeOriginal: "OffsetTimeOriginal",
  CreateDate: "OffsetTimeDigitized",
};

export function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"]);

/**
 * Recognises a file from its first bytes. Phone pickers (Android especially) often hand over
 * files named like "1000012345" or a UUID with no extension, so the name alone is not enough.
 */
export function sniffMediaType(head: Uint8Array): MediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "photo";
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === "PNG") return "photo";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "photo";
  if (head.length >= 12 && ascii(4, 8) === "ftyp") return HEIF_BRANDS.has(ascii(8, 12).toLowerCase()) ? "photo" : "video";
  if (head.length >= 8 && ["moov", "mdat", "wide", "free"].includes(ascii(4, 8))) return "video";
  return null;
}

/** Name first, then the browser's MIME type, then the bytes themselves. */
export function detectMediaType(filename: string, mimeType = "", head?: Uint8Array): MediaType {
  const suffix = extension(filename);
  if (PHOTO_EXTENSIONS.has(suffix)) return "photo";
  if (VIDEO_EXTENSIONS.has(suffix)) return "video";
  const sniffed = head ? sniffMediaType(head) : null;
  if (sniffed) return sniffed;
  if (/^image\/(jpeg|png|webp|hei[cf])/i.test(mimeType)) return "photo";
  if (/^video\//i.test(mimeType)) return "video";
  throw new Error(`Unsupported media type: ${filename}`);
}

/**
 * EXIF "2026:09:17 10:00:00" -> "2026-09-17T10:00:00" (plus offset when the camera recorded one).
 * ISO strings pass through. Zeroed or unparsable values are treated as missing.
 */
export function parseExifDatetime(value: unknown, offset?: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let text = String(value).trim();
  if (/^0000[:-]00[:-]00/.test(text)) return null;
  if (text.length >= 10 && text[4] === ":" && text[7] === ":") {
    text = `${text.slice(0, 4)}-${text.slice(5, 7)}-${text.slice(8)}`;
  }
  text = text.replace(" ", "T");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, date, time = "00:00:00", zone] = match;
  let normalized = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const extraZone = typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : undefined;
  if (zone) normalized += zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  else if (extraZone) normalized += extraZone;
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function numberOrNull(value: unknown, integer = false): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return integer ? Math.trunc(parsed) : parsed;
}

function timestamp(record: ExifRecord, mediaType: MediaType): {capturedAt: string | null; source: string | null} {
  const fields = mediaType === "photo" ? PHOTO_TIMESTAMP_FIELDS : VIDEO_TIMESTAMP_FIELDS;
  for (const field of fields) {
    const offsetField = OFFSET_FIELDS[field];
    const parsed = parseExifDatetime(record[field], offsetField ? record[offsetField] ?? record.OffsetTime : undefined);
    if (parsed) return {capturedAt: parsed, source: field};
  }
  return {capturedAt: null, source: null};
}

function gps(record: ExifRecord): {latitude: number | null; longitude: number | null; quality: GPSQuality; warnings: string[]} {
  const latitude = numberOrNull(record.GPSLatitude);
  const longitude = numberOrNull(record.GPSLongitude);
  if (latitude === null || longitude === null) return {latitude: null, longitude: null, quality: "missing", warnings: []};
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return {latitude: null, longitude: null, quality: "suspicious", warnings: ["gps_out_of_range"]};
  }
  return {latitude, longitude, quality: "valid", warnings: []};
}

export function normalizeMetadataRecord(record: ExifRecord, filename: string, id?: string, knownType?: MediaType): MediaPoint {
  const mediaType = knownType ?? detectMediaType(filename);
  const {capturedAt, source} = timestamp(record, mediaType);
  const location = gps(record);
  const warnings = [...location.warnings];
  if (capturedAt === null) warnings.push("missing_capture_time");
  return {
    id: id ?? uuid5(filename),
    filename,
    media_type: mediaType,
    captured_at: capturedAt,
    timestamp_source: source,
    latitude: location.latitude,
    longitude: location.longitude,
    altitude: numberOrNull(record.GPSAltitude),
    direction: numberOrNull(record.GPSImgDirection ?? record.GPSDestBearing),
    duration_seconds: numberOrNull(record.Duration),
    width: numberOrNull(record.ImageWidth, true),
    height: numberOrNull(record.ImageHeight, true),
    gps_quality: location.quality,
    metadata_warnings: warnings,
  };
}

export async function readMetadataRecord(source: ByteSource, mediaType: MediaType): Promise<ExifRecord> {
  if (mediaType === "video") return readQuickTime(source);
  const tiff = await findImageExif(source);
  return tiff ? parseTiff(tiff) : {};
}

/** Extracts a MediaPoint from a browser File/Blob. Unreadable metadata yields explicit gaps, not errors. */
export async function extractMetadata(file: Blob, filename: string, id?: string): Promise<MediaPoint> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const mediaType = detectMediaType(filename, file.type, head);
  let record: ExifRecord = {};
  let readFailed = false;
  try {
    record = await readMetadataRecord(blobSource(file), mediaType);
  } catch {
    readFailed = true;
  }
  const media = normalizeMetadataRecord(record, filename, id, mediaType);
  if (readFailed) media.metadata_warnings.push("metadata_unreadable");
  return media;
}
