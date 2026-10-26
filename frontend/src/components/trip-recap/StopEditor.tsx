"use client";

import {useState} from "react";
import {Button, Stack, Text, Token} from "@astryxdesign/core";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import type {TripData} from "@/lib/trip-types";

interface StopEditorProps {
  trip: TripData;
  busy: boolean;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (index: number) => void;
  onRename: (observationId: string, name: string) => void;
  onAdd: (query: string, position: number) => void;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

/** The route as an editable list: reorder, rename, remove, and add places by search. */
export default function StopEditor({trip, busy, onMove, onRemove, onRename, onAdd}: StopEditorProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<number>(-1);
  const count = trip.observations.length;

  const commitRename = (id: string) => {
    onRename(id, draft);
    setEditing(null);
  };

  return (
    <Stack gap={4}>
      <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
        <Text className="eyebrow">{count} stop{count === 1 ? "" : "s"} · in route order</Text>
        <Text type="supporting">↑ ↓ to reorder</Text>
      </Stack>
      <Stack as="ol" gap={0} className="editor-stops">
        {trip.observations.map((observation, index) => {
          const custom = observation.media_files.length === 0;
          return (
            <Stack as="li" key={observation.id} direction="horizontal" gap={3} paddingBlock={3} vAlign="start" className="editor-stop">
              <Text className="editor-stop-number">{String(index + 1).padStart(2, "0")}</Text>
              <Stack gap={1} className="editor-stop-copy">
                {editing === observation.id ? (
                  <input
                    className="editor-stop-input"
                    value={draft}
                    autoFocus
                    aria-label="Stop name"
                    placeholder="Leave empty to use the looked-up name"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(observation.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(observation.id);
                      if (event.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="editor-stop-name"
                    title="Rename this stop"
                    disabled={busy}
                    onClick={() => {
                      setEditing(observation.id);
                      setDraft(observation.place === "Looking up…" || observation.place === "Unknown place" ? "" : observation.place);
                    }}
                  >
                    {observation.place}
                  </button>
                )}
                <Text type="supporting">{custom ? "Place you added" : observation.media_files.join(", ")}</Text>
                {!custom && <Text type="supporting">{formatDate(observation.arrival)}</Text>}
                {custom && <Stack direction="horizontal"><Token label="added" color="purple" size="sm" /></Stack>}
              </Stack>
              <Stack direction="horizontal" gap={1} vAlign="center" className="editor-stop-actions">
                <Button label="Move up" icon={<Text aria-hidden="true">↑</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || index === 0} onClick={() => onMove(index, -1)} />
                <Button label="Move down" icon={<Text aria-hidden="true">↓</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || index === count - 1} onClick={() => onMove(index, 1)} />
                <Button label="Remove from route" icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || count <= 1} onClick={() => onRemove(index)} />
              </Stack>
            </Stack>
          );
        })}
      </Stack>

      <Stack className="editor-note" padding={4} gap={3}>
        <Text className="eyebrow">add a place</Text>
        <LocationAutocomplete id="add-stop" label="Search for a place" value={query} onChange={setQuery} placeholder="e.g. Lumbini Palace Resort" isDisabled={busy} />
        <label className="text-control" htmlFor="add-stop-position">
          <span>Position</span>
          <select id="add-stop-position" className="editor-select" value={position} disabled={busy} onChange={(event) => setPosition(Number(event.target.value))}>
            <option value={-1}>At the end</option>
            <option value={0}>At the start</option>
            {trip.observations.slice(0, -1).map((observation, index) => (
              <option key={observation.id} value={index + 1}>After {String(index + 1).padStart(2, "0")} · {observation.place}</option>
            ))}
          </select>
        </label>
        <Button
          label="Add to route"
          variant="secondary"
          width="100%"
          isDisabled={busy || query.trim().length < 2}
          onClick={() => {
            onAdd(query.trim(), position < 0 ? count : position);
            setQuery("");
          }}
        />
        <Text type="supporting">Added places have no photos, so the timeline estimates travel time from distance.</Text>
      </Stack>
    </Stack>
  );
}
