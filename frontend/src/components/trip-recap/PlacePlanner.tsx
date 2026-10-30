"use client";

import {useState} from "react";
import {Button, Stack, Text} from "@astryxdesign/core";
import InsertGap from "@/components/trip-recap/InsertGap";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import ReorderList from "@/components/trip-recap/ReorderList";
import type {RouteStopInput} from "@/lib/trip-api";

export type PlannedStop = Exclude<RouteStopInput, {id: string}>;

export interface PlannedPlace {
  key: string;
  label: string;
  stop: PlannedStop;
}

interface PlacePlannerProps {
  places: PlannedPlace[];
  busy: boolean;
  onChange: (places: PlannedPlace[]) => void;
  onBuild: () => void;
}

function shortName(displayName: string): string {
  return displayName.split(",")[0]?.trim() || displayName.trim();
}

/** A route made from searched places, for trips without geotagged photos or videos. */
export default function PlacePlanner({places, busy, onChange, onBuild}: PlacePlannerProps) {
  const [query, setQuery] = useState("");
  const count = places.length;

  const add = (place: Omit<PlannedPlace, "key">) => {
    onChange([...places, {...place, key: `${Date.now()}-${Math.random()}`}]);
    setQuery("");
  };

  const [insertAt, setInsertAt] = useState<number | null>(null);

  const reorder = (from: number, to: number) => {
    const next = [...places];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const insert = (stop: PlannedStop, label: string, position: number) => {
    const next = [...places];
    next.splice(position, 0, {label, stop, key: `${Date.now()}-${Math.random()}`});
    onChange(next);
    setInsertAt(null);
  };

  return (
    <Stack gap={4} className="place-planner">
      <Stack gap={1}>
        <Text className="planner-title">No photos? Plan the route by hand.</Text>
        <Text type="supporting">Add the places you went. Drag to reorder, or add a place between two others. Roads between them are traced for you.</Text>
      </Stack>

      <LocationAutocomplete
        id="plan-place"
        label="Add a place"
        value={query}
        onChange={setQuery}
        onSelect={(suggestion) => {
          if (!suggestion.display_name) return;
          const name = shortName(suggestion.display_name);
          add({label: name, stop: {latitude: suggestion.latitude, longitude: suggestion.longitude, name}});
        }}
        placeholder="Search a town, landmark or address"
        isDisabled={busy}
      />

      {count > 0 && (
        <ReorderList
          className="editor-stops"
          items={places}
          getKey={(place) => place.key}
          getLabel={(place) => place.label}
          isDisabled={busy || insertAt !== null}
          onReorder={reorder}
          renderGap={(position) => (
            <InsertGap
              position={position}
              count={count}
              isOpen={insertAt === position}
              isDisabled={busy}
              onOpen={() => setInsertAt(position)}
              onClose={() => setInsertAt(null)}
              onAdd={insert}
            />
          )}
          renderItem={(place, index, handle) => (
            <Stack direction="horizontal" gap={3} paddingBlock={2} vAlign="center">
              {handle}
              <Text className="editor-stop-number">{String(index + 1).padStart(2, "0")}</Text>
              <Text className="editor-stop-copy">{place.label}</Text>
              <Stack direction="horizontal" gap={1} vAlign="center" className="editor-stop-actions">
                <Button label={`Remove ${place.label}`} icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy} onClick={() => onChange(places.filter((item) => item.key !== place.key))} />
              </Stack>
            </Stack>
          )}
        />
      )}

      <Stack direction="horizontal" gap={3} vAlign="center" wrap="wrap">
        <Button
          label="Add as typed"
          variant="secondary"
          isDisabled={busy || query.trim().length < 2}
          onClick={() => add({label: shortName(query.trim()), stop: {query: query.trim()}})}
        />
        <button type="button" className="btn primary" disabled={busy || count < 2} onClick={onBuild}>
          {busy ? "Tracing route…" : "Build route from places"}
        </button>
        {count < 2 && <Text type="supporting">{count === 0 ? "Add at least two places." : "Add one more place."}</Text>}
      </Stack>
    </Stack>
  );
}
