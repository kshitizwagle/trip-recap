"use client";

import {useState} from "react";
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

type Filter = "all" | "no-gps" | "no-time" | "failed";

function capturedLabel(value: string | null): string {
  if (!value) return "no capture time";
  return new Date(value).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
}

function statusLabel(record: MediaUploadRecord): string {
  if (record.status === "uploaded") {
    return `${capturedLabel(record.evidence?.capturedAt ?? null)} · ${record.evidence?.hasGps ? "has location" : "no location"}`;
  }
  if (record.status === "uploading") return "reading metadata…";
  if (record.status === "failed") return record.message || "could not read this file";
  return "queued";
}

function isVideo(record: MediaUploadRecord): boolean {
  return record.file.type.startsWith("video/") || /\.(mov|mp4|m4v)$/i.test(record.file.name);
}

const matches: Record<Filter, (record: MediaUploadRecord) => boolean> = {
  all: () => true,
  "no-gps": (record) => record.status === "uploaded" && !record.evidence?.hasGps,
  "no-time": (record) => record.status === "uploaded" && !record.evidence?.capturedAt,
  failed: (record) => record.status === "failed",
};

/**
 * The chosen media as a thumbnail grid that scrolls inside its own box, so hundreds of files keep
 * the page short. Each tile marks whether its location and capture time were found, and filters
 * pull out the files that need attention.
 */
export default function MediaQueue({records, onDiscard, onRetry, isDisabled = false}: MediaQueueProps) {
  const [filter, setFilter] = useState<Filter>("all");
  if (!records.length) return null;
  const read = records.filter((record) => record.status === "uploaded").length;
  const counts: Record<Filter, number> = {
    all: records.length,
    "no-gps": records.filter(matches["no-gps"]).length,
    "no-time": records.filter(matches["no-time"]).length,
    failed: records.filter(matches.failed).length,
  };
  const active = counts[filter] ? filter : "all";
  const shown = records.filter(matches[active]);
  const reading = read + counts.failed < records.length;
  const filters: Array<[Filter, string]> = [["all", "All"], ["no-gps", "No location"], ["no-time", "No time"], ["failed", "Failed"]];

  return (
    <section className="media-queue" id="media-grid" aria-label="Selected trip media">
      <header className="media-queue__head">
        <p className="eyebrow">media · {records.length}</p>
        <p className="media-queue__count">
          {reading ? `reading ${read + counts.failed} of ${records.length}` : `${records.length - counts["no-gps"] - counts.failed} with location`}
        </p>
      </header>
      {reading && (
        <span className="media-queue__track" aria-hidden="true">
          <span className="media-queue__bar" style={{transform: `scaleX(${(read + counts.failed) / records.length})`}} />
        </span>
      )}
      {(counts["no-gps"] > 0 || counts["no-time"] > 0 || counts.failed > 0) && (
        <div className="media-queue__filters" role="group" aria-label="Show media">
          {filters.filter(([value]) => value === "all" || counts[value] > 0).map(([value, label]) => (
            <button key={value} type="button" className="chip" aria-pressed={active === value} onClick={() => setFilter(value)}>
              {label} <span>{counts[value]}</span>
            </button>
          ))}
        </div>
      )}
      <ul className="media-grid">
        {shown.map((record) => {
          const video = isVideo(record);
          const tone = record.status === "failed" ? "is-failed" : record.status === "uploaded" ? (record.evidence?.hasGps ? "is-located" : "is-unlocated") : "is-pending";
          return (
            <li key={record.clientId} className={`media-tile ${tone}`} data-client-id={record.clientId} title={`${record.file.name}\n${statusLabel(record)}`}>
              <span className="media-tile__kind" aria-hidden="true">{video ? "VID" : "IMG"}</span>
              {record.objectUrl && (video ? (
                <video src={`${record.objectUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />
              ) : (
                <img src={record.objectUrl} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true; }} />
              ))}
              {record.status === "uploading" || record.status === "queued" ? (
                <span className="media-tile__progress" aria-hidden="true"><span style={{transform: `scaleX(${record.progress / 100})`}} /></span>
              ) : null}
              {record.status === "uploaded" && (
                <span className="media-tile__flags" aria-hidden="true">
                  <span className={record.evidence?.hasGps ? "flag is-on" : "flag"}>GPS</span>
                  {!record.evidence?.capturedAt && <span className="flag">no time</span>}
                </span>
              )}
              <span className="visually-hidden">{record.file.name}: {statusLabel(record)}</span>
              {record.status === "failed" && (
                <button type="button" className="media-tile__retry" disabled={isDisabled} onClick={() => onRetry(record)} aria-label={`Retry ${record.file.name}`}>retry</button>
              )}
              <button type="button" className="media-tile__remove" disabled={isDisabled} onClick={() => onDiscard(record)} aria-label={`Remove ${record.file.name}`}>×</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
