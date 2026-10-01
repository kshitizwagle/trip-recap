import {defineTheme} from "@astryxdesign/core/theme";
import {neutralTheme} from "@astryxdesign/theme-neutral/built";

// Aura Dark design system (https://claude.ai/artifact/LSpDBi6S1ajCuWSh6PP527).
// Dark-only: each tuple repeats the dark value so `mode` cannot pull in a light palette.
const aura = {
  bg: "#15141b",
  surface: "#1d1c25",
  surfaceRaised: "#25242f",
  fg: "#edecee",
  muted: "#bdbdbd",
  metadata: "#908f98",
  gray: "#6d6d6d",
  border: "#2e2c3a",
  accent: "#a277ff",
  accentSoft: "#8464c6",
  accentInk: "#15141b",
  green: "#61ffca",
  blue: "#82e2ff",
  pink: "#f694ff",
  warning: "#ffca85",
  danger: "#ff6767",
} as const;

const both = (value: string): [string, string] => [value, value];

export const tripRecapTheme = defineTheme({
  name: "aura-dark",
  extends: neutralTheme,
  color: {
    accent: both(aura.accent),
    neutralStyle: "cool",
    contrast: "standard",
  },
  typography: {
    body: {
      family: "IBM Plex Mono",
      fallbacks: "SFMono-Regular, Consolas, ui-monospace, monospace",
    },
    heading: {
      family: "Fraunces",
      fallbacks: "Georgia, serif",
      weight: "semibold",
    },
    code: {
      family: "IBM Plex Mono",
      fallbacks: "SFMono-Regular, Consolas, ui-monospace, monospace",
    },
  },
  // Aura radius-md (6px) is the default for cards, rows and inputs.
  radius: {base: 4, multiplier: 0.75},
  motion: {fast: 160, medium: 420, ratio: 0.75, easing: "cubic-bezier(0.23, 1, 0.32, 1)"},
  tokens: {
    "--color-background-body": both(aura.bg),
    "--color-background-surface": both(aura.surface),
    "--color-background-card": both(aura.surface),
    "--color-background-muted": both(aura.surfaceRaised),
    "--color-background-popover": both(aura.surfaceRaised),
    "--color-text-primary": both(aura.fg),
    "--color-text-secondary": both(aura.muted),
    "--color-text-disabled": both(aura.gray),
    "--color-icon-primary": both(aura.fg),
    "--color-icon-secondary": both(aura.muted),
    "--color-icon-disabled": both(aura.gray),
    "--color-border": both(aura.border),
    "--color-on-accent": both(aura.accentInk),
    "--color-success": both(aura.green),
    "--color-warning": both(aura.warning),
    "--color-error": both(aura.danger),
    "--color-text-green": both(aura.green),
    "--color-text-blue": both(aura.blue),
    "--color-text-pink": both(aura.pink),
    "--color-text-orange": both(aura.warning),
    "--color-text-red": both(aura.danger),
  },
});
