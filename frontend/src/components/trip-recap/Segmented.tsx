"use client";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  isDisabled?: boolean;
}

/** A small label plus joined pill buttons, as in the trip-map artifact. */
export default function Segmented<T extends string | number>({label, value, options, onChange, isDisabled = false}: SegmentedProps<T>) {
  return (
    <div className="grp" role="group" aria-label={label}>
      <span className="grp-label" aria-hidden="true">{label}</span>
      <div className="seg">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === value}
            disabled={isDisabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
