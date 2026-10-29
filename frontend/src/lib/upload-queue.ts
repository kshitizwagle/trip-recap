import {extension, SUPPORTED_EXTENSIONS} from "./engine/metadata/extract.ts";

export const MAX_CONCURRENT_UPLOADS = 4;
// No hard cap on file count, but past this the browser slows down reading, previewing and exporting.
export const LARGE_UPLOAD_COUNT = 100;
// Files are read locally, so the limit only guards browser memory during preview and export.
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILE_LABEL = "1 GB";

export type UploadStatus = "queued" | "uploading" | "uploaded" | "failed";

export interface UploadRecord<TFile = File> {
  clientId: string;
  file: TFile;
  status: UploadStatus;
  discarded: boolean;
  serverId: string | null;
  progress: number;
  message: string;
}

export interface FileLike {
  name: string;
  size: number;
  type?: string;
}

/**
 * Photos and videos the metadata parser can read. A known extension decides; files with no
 * extension (common from Android pickers) are kept when the browser reports a media MIME type or
 * none at all, since extraction sniffs their bytes.
 */
export function isSupportedMedia(file: Pick<FileLike, "name" | "type">): boolean {
  const suffix = extension(file.name);
  if (suffix) return SUPPORTED_EXTENSIONS.has(suffix);
  const type = file.type ?? "";
  return !type || /^image\/(jpeg|png|webp|hei[cf])$/i.test(type) || /^video\/(mp4|quicktime|x-m4v)$/i.test(type);
}

export function partitionFiles<T extends FileLike>(
  files: readonly T[],
  maxBytes = MAX_FILE_BYTES,
): {accepted: T[]; rejected: T[]; unsupported: T[]} {
  return files.reduce(
    (result, file) => {
      result[!isSupportedMedia(file) ? "unsupported" : file.size <= maxBytes ? "accepted" : "rejected"].push(file);
      return result;
    },
    {accepted: [], rejected: [], unsupported: []} as {accepted: T[]; rejected: T[]; unsupported: T[]},
  );
}

export function canAnalyze(
  records: readonly Pick<UploadRecord, "status" | "discarded">[],
): boolean {
  const hasReadyUpload = records.some(
    (record) => !record.discarded && record.status === "uploaded",
  );
  const hasPendingUpload = records.some(
    (record) =>
      !record.discarded &&
      (record.status === "queued" || record.status === "uploading"),
  );
  return hasReadyUpload && !hasPendingUpload;
}

export function resetUploadForRetry(
  record: Pick<UploadRecord, "status" | "progress" | "message">,
): Pick<UploadRecord, "status" | "progress" | "message"> {
  return {...record, status: "queued", progress: 0, message: "Queued"};
}
