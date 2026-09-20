"use client";

import {useEffect, useRef, useState} from "react";
import {Spinner} from "@astryxdesign/core";
import {searchLocations, type LocationSuggestion} from "@/lib/trip-api";

interface LocationAutocompleteProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  isDisabled?: boolean;
  onChange: (value: string) => void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export default function LocationAutocomplete({
  id,
  label,
  value,
  placeholder,
  isDisabled = false,
  onChange,
}: LocationAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const selectionRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const listboxId = `${id}-suggestions`;

  useEffect(() => {
    requestRef.current?.abort();

    if (selectionRef.current) {
      selectionRef.current = false;
      setIsLoading(false);
      setSuggestions([]);
      setActiveIndex(-1);
      setIsOpen(false);
      return;
    }

    const query = value.trim();
    if (query.length < 2 || isDisabled) {
      setIsLoading(false);
      setSuggestions([]);
      setActiveIndex(-1);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    const timeout = window.setTimeout(() => {
      const controller = new AbortController();
      requestRef.current = controller;
      searchLocations(query, controller.signal)
        .then(({results}) => {
          if (controller.signal.aborted) return;
          setIsLoading(false);
          const next = results.filter((result) => result.display_name).slice(0, 5);
          setSuggestions(next);
          setActiveIndex(-1);
          setIsOpen(next.length > 0);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setIsLoading(false);
          setSuggestions([]);
          setActiveIndex(-1);
          setIsOpen(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      requestRef.current?.abort();
    };
  }, [isDisabled, value]);

  useEffect(() => () => {
    requestRef.current?.abort();
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  function selectSuggestion(suggestion: LocationSuggestion) {
    if (!suggestion.display_name) return;
    selectionRef.current = true;
    onChange(suggestion.display_name);
    setSuggestions([]);
    setActiveIndex(-1);
    setIsOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === "Enter" && isOpen && activeIndex >= 0) {
      event.preventDefault();
      selectSuggestion(suggestions[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
      setActiveIndex(-1);
    }
  }

  function handleBlur() {
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      setActiveIndex(-1);
    }, 120);
  }

  function keepOpen(event: React.MouseEvent<HTMLLIElement>) {
    event.preventDefault();
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }

  return (
    <label className="text-control location-control" htmlFor={id}>
      <span>{label}</span>
      <span className="location-input-wrap">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (suggestions.length) setIsOpen(true); }}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={isDisabled}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-busy={isLoading}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${id}-suggestion-${activeIndex}` : undefined}
          autoComplete="off"
        />
        {isLoading && (
          <Spinner
            size="sm"
            shade="inherit"
            aria-label="Loading location suggestions"
            aria-hidden="true"
            className="location-loading-spinner"
          />
        )}
        {isOpen && suggestions.length > 0 && (
          <ul id={listboxId} className="location-suggestions" role="listbox">
            {suggestions.map((suggestion, index) => (
              <li
                id={`${id}-suggestion-${index}`}
                key={`${suggestion.latitude}:${suggestion.longitude}:${suggestion.display_name}`}
                className={`location-suggestion${index === activeIndex ? " is-active" : ""}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={keepOpen}
                onClick={() => selectSuggestion(suggestion)}
              >
                <span className="location-suggestion-name">{suggestion.display_name}</span>
                <span className="location-suggestion-coordinates">{suggestion.latitude.toFixed(4)}, {suggestion.longitude.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        )}
      </span>
    </label>
  );
}
