"use client";

import {Button, ProgressBar, Stack, Text, Token} from "@astryxdesign/core";
import type {UploadRecord} from "@/lib/upload-queue";
import type {UploadRequest} from "@/lib/trip-api";

export interface MediaEvidence {
  capturedAt: string | null;
  hasGps: boolean;
}

export type MediaUploadRecord = UploadRecord<File> & {
  objectUrl: string | null;
  request?: UploadRequest;
  evidence?: MediaEvidence;
};

interface MediaQueueProps {
  records: MediaUploadRecord[];
  onDiscard: (record: MediaUploadRecord) => void;
  onRetry: (record: MediaUploadRecord) => void;
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

function capturedLabel(value: string | null): string {
  if (!value) return "no capture time";
  return new Date(value).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
}

function statusLabel(record: MediaUploadRecord): string {
  if (record.status === "uploaded") return capturedLabel(record.evidence?.capturedAt ?? null);
  if (record.status === "uploading") return "reading metadata…";
  if (record.status === "failed") return record.message || "could not read this file";
  return "queued";
}

function isVideo(record: MediaUploadRecord): boolean {
  return record.file.type.startsWith("video/") || /\.(mov|mp4|m4v)$/i.test(record.file.name);
}

export default function MediaQueue({records, onDiscard, onRetry, isDisabled = false}: MediaQueueProps) {
  const located = records.filter((record) => record.evidence?.hasGps).length;
  return (
    <Stack as="section" gap={3} id="media-grid" aria-label="Selected trip media" hidden={!records.length}>
      <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
        <Text className="eyebrow">media · {records.length}</Text>
        <Text type="supporting">{located} with GPS</Text>
      </Stack>
      <Stack as="ul" gap={0} className="editor-media-list">
        {records.map((record) => (
          <Stack as="li" key={record.clientId} direction="horizontal" gap={3} paddingBlock={3} vAlign="center" className="editor-media-row" data-client-id={record.clientId}>
            <Stack className="editor-media-thumb" hAlign="center" vAlign="center">
              {isVideo(record) ? (
                <video src={record.objectUrl ?? undefined} muted playsInline preload="metadata" aria-label={record.file.name} />
              ) : record.objectUrl ? (
                <img src={record.objectUrl} alt={record.file.name} onError={(event) => { event.currentTarget.hidden = true; }} />
              ) : null}
              <Text type="supporting" className="editor-media-kind" aria-hidden="true">{isVideo(record) ? "VID" : "IMG"}</Text>
            </Stack>
            <Stack gap={1} className="editor-media-copy">
              <Text maxLines={1} weight="medium">{record.file.name}</Text>
              <Text type="supporting">{humanSize(record.file.size)} · {statusLabel(record)}</Text>
              {record.status === "uploaded" ? (
                <Stack direction="horizontal" gap={1} wrap="wrap">
                  <Token label={record.evidence?.hasGps ? "GPS" : "no GPS"} color={record.evidence?.hasGps ? "teal" : "gray"} size="sm" />
                  <Token label={record.evidence?.capturedAt ? "time" : "no time"} color={record.evidence?.capturedAt ? "purple" : "gray"} size="sm" />
                </Stack>
              ) : (
                <ProgressBar value={record.progress} label={`${record.file.name} progress`} isLabelHidden variant={record.status === "failed" ? "error" : "accent"} />
              )}
            </Stack>
            <Stack direction="horizontal" gap={1} vAlign="center">
              {record.status === "failed" && <Button isDisabled={isDisabled} label="Retry" variant="secondary" size="sm" onClick={() => onRetry(record)} />}
              <Button isDisabled={isDisabled} label={`Remove ${record.file.name}`} icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" onClick={() => onDiscard(record)} />
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
