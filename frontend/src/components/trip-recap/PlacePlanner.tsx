"use client";

import {useState} from "react";
import {Button, Stack, Text} from "@astryxdesign/core";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
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

  const move = (index: number, delta: -1 | 1) => {
    const next = [...places];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };

  return (
    <Stack gap={4} className="place-planner">
      <Stack gap={1}>
        <Text className="planner-title">No photos? Plan the route by hand.</Text>
        <Text type="supporting">Add the places you went, in order. Roads between them are traced for you.</Text>
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
        <Stack as="ol" gap={0} className="editor-stops">
          {places.map((place, index) => (
            <Stack as="li" key={place.key} direction="horizontal" gap={3} paddingBlock={2} vAlign="center">
              <Text className="editor-stop-number">{String(index + 1).padStart(2, "0")}</Text>
              <Text className="editor-stop-copy">{place.label}</Text>
              <Stack direction="horizontal" gap={1} vAlign="center" className="editor-stop-actions">
                <Button label="Move up" icon={<Text aria-hidden="true">↑</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || index === 0} onClick={() => move(index, -1)} />
                <Button label="Move down" icon={<Text aria-hidden="true">↓</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy || index === count - 1} onClick={() => move(index, 1)} />
                <Button label={`Remove ${place.label}`} icon={<Text aria-hidden="true">×</Text>} isIconOnly variant="ghost" size="sm" isDisabled={busy} onClick={() => onChange(places.filter((item) => item.key !== place.key))} />
              </Stack>
            </Stack>
          ))}
        </Stack>
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
