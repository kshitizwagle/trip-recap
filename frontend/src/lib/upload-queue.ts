export const MAX_CONCURRENT_UPLOADS = 4;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
}

export function partitionFiles<T extends FileLike>(
  files: readonly T[],
  maxBytes = MAX_FILE_BYTES,
): {accepted: T[]; rejected: T[]} {
  return files.reduce(
    (result, file) => {
      result[file.size <= maxBytes ? "accepted" : "rejected"].push(file);
      return result;
    },
    {accepted: [], rejected: []} as {accepted: T[]; rejected: T[]},
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
