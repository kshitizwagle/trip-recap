"use client";

import {useState} from "react";
import {Button, Stack, Text, Token} from "@astryxdesign/core";
import InsertGap from "@/components/trip-recap/InsertGap";
import ReorderList from "@/components/trip-recap/ReorderList";
import type {RouteStopInput} from "@/lib/trip-api";
import type {TripData} from "@/lib/trip-types";

interface StopEditorProps {
  trip: TripData;
  busy: boolean;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onRename: (observationId: string, name: string) => void;
  onAdd: (stop: RouteStopInput, position: number) => void;
}

const ENDPOINT_LABELS = {start: "Start point you set", end: "End point you set", return: "Return to start"} as const;

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

/** The route as an editable list: drag to reorder, rename, remove, and add a place between any two stops. */
export default function StopEditor({trip, busy, onReorder, onRemove, onRename, onAdd}: StopEditorProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const count = trip.observations.length;

  const commitRename = (id: string) => {
    onRename(id, draft);
    setEditing(null);
  };

  return (
    <Stack gap={3}>
      <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
        <Text className="eyebrow">{count} stop{count === 1 ? "" : "s"} · in route order</Text>
        <Text type="supporting">drag to reorder · + to add between</Text>
      </Stack>
      <ReorderList
        className="editor-stops"
        items={trip.observations}
        getKey={(observation) => observation.id}
        getLabel={(observation) => observation.place}
        isDisabled={busy || insertAt !== null}
        onReorder={onReorder}
        renderGap={(position) => (
          <InsertGap
            position={position}
            count={count}
            isOpen={insertAt === position}
            isDisabled={busy}
            onOpen={() => setInsertAt(position)}
            onClose={() => setInsertAt(null)}
            onAdd={(stop, _label, at) => {
              onAdd(stop, at);
              setInsertAt(null);
            }}
          />
        )}
        renderItem={(observation, index, handle) => {
          const custom = observation.media_files.length === 0;
          const origin = observation.endpoint ? ENDPOINT_LABELS[observation.endpoint] : custom ? "Place you added" : observation.media_files.join(", ");
          return (
            <Stack direction="horizontal" gap={3} paddingBlock={3} vAlign="start" className="editor-stop">
              {handle}
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
                <Text type="supporting" maxLines={1}>{origin}</Text>
                {!custom && <Text type="supporting">{formatDate(observation.arrival)}</Text>}
                {custom && <Stack direction="horizontal"><Token label={observation.endpoint ? "from options" : "added"} color="purple" size="sm" /></Stack>}
              </Stack>
              <Stack direction="horizontal" gap={1} vAlign="center" className="editor-stop-actions">
                <Button label="Remove from route" icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || count <= 1} onClick={() => onRemove(index)} />
              </Stack>
            </Stack>
          );
        }}
      />
      <Text type="supporting">Added places have no photos, so travel time to them is estimated from distance.</Text>
    </Stack>
  );
}
