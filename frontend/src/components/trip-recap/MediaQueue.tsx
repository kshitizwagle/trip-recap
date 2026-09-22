"use client";

import {Button, ProgressBar, Stack, Text, Token} from "@astryxdesign/core";
import type {UploadRecord} from "@/lib/upload-queue";
import type {UploadRequest} from "@/lib/trip-api";

export type MediaUploadRecord = UploadRecord<File> & {
  objectUrl: string | null;
  request?: UploadRequest;
};

interface MediaQueueProps {
  records: MediaUploadRecord[];
  onDiscard: (record: MediaUploadRecord) => void;
  isDisabled?: boolean;
}

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function statusLabel(record: MediaUploadRecord): string {
  if (record.status === "uploaded") return "Retained";
  if (record.status === "uploading") return `${Math.round(record.progress)}% uploading`;
  if (record.status === "failed") return record.message || "Upload failed";
  return "Queued";
}

function isVideo(record: MediaUploadRecord): boolean {
  return record.file.type.startsWith("video/") || /\.(mov|mp4|m4v)$/i.test(record.file.name);
}

export default function MediaQueue({records, onDiscard, isDisabled = false}: MediaQueueProps) {
  return (
    <Stack as="section" gap={3} id="media-grid" aria-label="Selected trip media" hidden={!records.length}>
      <Text weight="semibold">Your media · {records.length}</Text>
      <Stack as="ul" gap={0} className="editor-media-list">
        {records.map((record) => (
          <Stack as="li" key={record.clientId} direction="horizontal" gap={3} paddingBlock={3} vAlign="center" className="editor-media-row" data-client-id={record.clientId}>
            <Stack className="editor-media-thumb" hAlign="center" vAlign="center">
              {isVideo(record) ? (
                <video src={record.objectUrl ?? undefined} muted playsInline preload="metadata" aria-label={record.file.name} />
              ) : record.objectUrl ? (
                <img src={record.objectUrl} alt={record.file.name} />
              ) : <Text type="supporting">IMG</Text>}
            </Stack>
            <Stack gap={1} className="editor-media-copy">
              <Text maxLines={1} weight="medium">{record.file.name}</Text>
              <Text type="supporting">{humanSize(record.file.size)} · {statusLabel(record)}</Text>
              {record.status === "uploaded" ? <Token label="Ready" color="teal" size="sm" /> : <ProgressBar value={record.progress} label={`${record.file.name} upload progress`} isLabelHidden variant={record.status === "failed" ? "error" : "accent"} />}
            </Stack>
            <Button isDisabled={isDisabled} label={`Discard ${record.file.name}`} icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" onClick={() => onDiscard(record)} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
