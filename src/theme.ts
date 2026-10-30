import {defineTheme} from "@astryxdesign/core/theme";
import {neutralTheme} from "@astryxdesign/theme-neutral/built";

// Light: a neutral zinc palette with one blue accent.
// Dark: the Aura Dark design system (https://claude.ai/artifact/LSpDBi6S1ajCuWSh6PP527).
// Each token is a [light, dark] pair; `<Theme mode="system">` picks one from the OS setting.
const light = {
  bg: "#f4f4f5",
  surface: "#ffffff",
  surfaceRaised: "#e4e4e7",
  fg: "#18181b",
  muted: "#52525b",
  disabled: "#a1a1aa",
  border: "#e4e4e7",
  accent: "#2457d6",
  accentInk: "#ffffff",
  green: "#166534",
  blue: "#1d4ed8",
  pink: "#a21caf",
  warning: "#92400e",
  danger: "#b42318",
} as const;

const aura = {
  bg: "#15141b",
  surface: "#1d1c25",
  surfaceRaised: "#25242f",
  fg: "#edecee",
  muted: "#bdbdbd",
  disabled: "#6d6d6d",
  border: "#2e2c3a",
  accent: "#a277ff",
  accentInk: "#15141b",
  green: "#61ffca",
  blue: "#82e2ff",
  pink: "#f694ff",
  warning: "#ffca85",
  danger: "#ff6767",
} as const;

const pair = (key: keyof typeof light): [string, string] => [light[key], aura[key]];

export const tripRecapTheme = defineTheme({
  name: "trip-recap",
  extends: neutralTheme,
  color: {
    accent: pair("accent"),
    neutralStyle: "cool",
    contrast: "standard",
  },
  typography: {
    body: {
      family: "Inter",
      fallbacks: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
    },
    heading: {
      family: "Inter",
      fallbacks: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
      weight: "semibold",
    },
    code: {
      family: "JetBrains Mono",
      fallbacks: "SFMono-Regular, Consolas, ui-monospace, monospace",
    },
  },
  radius: {base: 4, multiplier: 1},
  motion: {fast: 160, medium: 420, ratio: 0.75, easing: "cubic-bezier(0.23, 1, 0.32, 1)"},
  tokens: {
    "--color-background-body": pair("bg"),
    "--color-background-surface": pair("surface"),
    "--color-background-card": pair("surface"),
    "--color-background-muted": pair("surfaceRaised"),
    "--color-background-popover": pair("surface"),
    "--color-text-primary": pair("fg"),
    "--color-text-secondary": pair("muted"),
    "--color-text-disabled": pair("disabled"),
    "--color-icon-primary": pair("fg"),
    "--color-icon-secondary": pair("muted"),
    "--color-icon-disabled": pair("disabled"),
    "--color-border": pair("border"),
    "--color-on-accent": pair("accentInk"),
    "--color-success": pair("green"),
    "--color-warning": pair("warning"),
    "--color-error": pair("danger"),
    "--color-text-green": pair("green"),
    "--color-text-blue": pair("blue"),
    "--color-text-pink": pair("pink"),
    "--color-text-orange": pair("warning"),
    "--color-text-red": pair("danger"),
  },
});
