"use client";

import {Badge, Button, Card, ProgressBar, Stack, Text} from "@astryxdesign/core";
import type {UploadRecord} from "@/lib/upload-queue";
import type {UploadRequest} from "@/lib/trip-api";

export type MediaUploadRecord = UploadRecord<File> & {
  objectUrl: string | null;
  request?: UploadRequest;
};

interface MediaQueueProps {
  records: MediaUploadRecord[];
  onDiscard: (record: MediaUploadRecord) => void;
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

function statusVariant(status: MediaUploadRecord["status"]): "neutral" | "success" | "warning" | "error" {
  if (status === "uploaded") return "success";
  if (status === "failed") return "error";
  if (status === "uploading") return "warning";
  return "neutral";
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

export default function MediaQueue({records, onDiscard}: MediaQueueProps) {
  return (
    <section className="media-queue" id="media-grid" aria-label="Selected trip media" hidden={!records.length}>
      <header className="section-heading section-heading-compact">
        <Text as="p" type="label" className="eyebrow">01 / MEDIA QUEUE</Text>
        <Text as="p" type="supporting" color="secondary">Uploads begin immediately. Discarded files never reach route analysis.</Text>
      </header>
      <Stack as="ul" direction="horizontal" gap={3} wrap="wrap" className="media-grid">
        {records.map((record) => (
          <li key={record.clientId} className="media-card" data-client-id={record.clientId}>
            <Card variant="transparent" padding={0} className="media-card-inner">
              <div className="media-preview">
                {isVideo(record) ? (
                  <video src={record.objectUrl ?? undefined} muted playsInline preload="metadata" aria-label={record.file.name} />
                ) : record.objectUrl ? (
                  <img src={record.objectUrl} alt={record.file.name} />
                ) : (
                  <span className="media-placeholder" aria-hidden="true">IMG</span>
                )}
                <Button
                  label={`Discard ${record.file.name}`}
                  icon={<span className="media-discard-icon" aria-hidden="true">×</span>}
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  className="media-discard-button"
                  onClick={() => onDiscard(record)}
                />
              </div>
              <Stack gap={1} padding={3} className="media-card-copy">
                <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
                  <Text type="label" maxLines={1} hasTruncateTooltip>{record.file.name}</Text>
                  <Badge variant={statusVariant(record.status)} label={record.status === "uploaded" ? "READY" : record.status.toUpperCase()} />
                </Stack>
                <Text type="supporting" color="secondary">{humanSize(record.file.size)} · {statusLabel(record)}</Text>
                <ProgressBar value={record.progress} label={`${record.file.name} upload progress`} isLabelHidden variant={record.status === "failed" ? "error" : "accent"} />
              </Stack>
            </Card>
          </li>
        ))}
      </Stack>
    </section>
  );
}
