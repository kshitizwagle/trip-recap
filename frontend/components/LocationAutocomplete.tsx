'use client';

import { useEffect, useRef, useState } from 'react';
import type { LocationSuggestion } from '@/lib/types';
import { readApiResponse } from '@/lib/api';

function parseCoordinates(value: string): LocationSuggestion | null {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { label: value, latitude, longitude, type: 'coordinates' };
}

export function coordinateText(value: Pick<LocationSuggestion, 'latitude' | 'longitude'>) {
  return `${value.latitude.toFixed(6)}, ${value.longitude.toFixed(6)}`;
}

export default function LocationAutocomplete({
  label,
  placeholder,
  disabled = false,
  onChange,
}: {
  label: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<LocationSuggestion | null>(null);
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const query = value.trim();
    const coordinates = parseCoordinates(query);
    if (coordinates) {
      if (
        !selected ||
        selected.label !== query ||
        selected.latitude !== coordinates.latitude ||
        selected.longitude !== coordinates.longitude
      ) {
        setSelected(coordinates);
      }
      setSuggestions([]);
      setOpen(false);
      onChange(coordinateText(coordinates));
      return;
    }

    if (selected && query !== selected.label) setSelected(null);
    if (!query) onChange(null);
    else if (!selected) onChange(query);

    if (disabled || query.length < 3 || selected?.label === query) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(
          `/api/locations/suggest?q=${encodeURIComponent(query)}&limit=5`,
          { signal: controller.signal },
        );
        const parsed = await readApiResponse<{ suggestions: LocationSuggestion[] }>(response);
        if (!parsed.ok || !parsed.data) return;
        setSuggestions(parsed.data.suggestions ?? []);
        setOpen((parsed.data.suggestions ?? []).length > 0);
        setActiveIndex(-1);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [value, selected, disabled, onChange]);

  function choose(item: LocationSuggestion) {
    setValue(item.label);
    setSelected(item);
    setOpen(false);
    setSuggestions([]);
    onChange(coordinateText(item));
  }

  return (
    <label className="field location-field">
      <span>{label}</span>
      <div className="location-input-wrap">
        <input
          value={value}
          disabled={disabled}
          autoComplete="off"
          placeholder={placeholder}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setValue(event.target.value);
            if (selected && event.target.value !== selected.label) setSelected(null);
          }}
          onKeyDown={(event) => {
            if (!open || !suggestions.length) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => (index + 1 + suggestions.length) % suggestions.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
            } else if (event.key === 'Enter' && activeIndex >= 0) {
              event.preventDefault();
              choose(suggestions[activeIndex]);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {open && (
          <div className="suggestions" role="listbox">
            {suggestions.map((item, index) => (
              <button
                type="button"
                key={`${item.latitude}:${item.longitude}:${item.label}`}
                className={`suggestion ${activeIndex === index ? 'active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <strong>{item.label}</strong>
                <small>{item.type ?? 'place'} · {coordinateText(item)}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <small className={selected ? 'coordinate selected' : 'coordinate'}>
        {selected ? `Coordinates: ${coordinateText(selected)}` : ' '}
      </small>
    </label>
  );
}
