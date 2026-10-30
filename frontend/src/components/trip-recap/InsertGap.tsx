"use client";

import {useEffect, useState} from "react";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import type {PlannedStop} from "@/components/trip-recap/PlacePlanner";

interface InsertGapProps {
  /** Where a new place goes: 0 is before the first stop, the list length is after the last. */
  position: number;
  count: number;
  isOpen: boolean;
  isDisabled?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdd: (stop: PlannedStop, label: string, position: number) => void;
}

function shortName(displayName: string): string {
  return displayName.split(",")[0]?.trim() || displayName.trim();
}

/** The seam between two stops: a slim "add here" line that opens a place search in that spot. */
export default function InsertGap({position, count, isOpen, isDisabled = false, onOpen, onClose, onAdd}: InsertGapProps) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (isOpen) document.getElementById(`insert-${position}`)?.focus();
  }, [isOpen, position]);
  const where = position === 0 ? "before the first stop" : position >= count ? "after the last stop" : `between stops ${position} and ${position + 1}`;

  if (!isOpen) {
    return (
      <button type="button" className="insert-gap" disabled={isDisabled} onClick={onOpen} aria-label={`Add a place ${where}`}>
        <span aria-hidden="true">+ add here</span>
      </button>
    );
  }

  const addTyped = () => {
    const text = query.trim();
    if (text.length < 2) return;
    onAdd({query: text}, shortName(text), position);
    setQuery("");
  };

  return (
    <div className="insert-form" role="group" aria-label={`Add a place ${where}`}>
      <LocationAutocomplete
        id={`insert-${position}`}
        label={`Add a place ${where}`}
        value={query}
        onChange={setQuery}
        onSelect={(suggestion) => {
          if (!suggestion.display_name) return;
          const name = shortName(suggestion.display_name);
          onAdd({latitude: suggestion.latitude, longitude: suggestion.longitude, name}, name, position);
          setQuery("");
        }}
        placeholder="Search a town, landmark or address"
        isDisabled={isDisabled}
      />
      <div className="insert-form__actions">
        <button type="button" className="btn small" disabled={isDisabled || query.trim().length < 2} onClick={addTyped}>Add as typed</button>
        <button type="button" className="btn small" onClick={() => { setQuery(""); onClose(); }}>Cancel</button>
      </div>
    </div>
  );
}
