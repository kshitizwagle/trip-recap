import {defineTheme} from "@astryxdesign/core/theme";
import {neutralTheme} from "@astryxdesign/theme-neutral/built";

export const tripRecapTheme = defineTheme({
  name: "trip-recap",
  extends: neutralTheme,
  color: {
    accent: ["#8b78df", "#b5a8ff"],
    neutralStyle: "warm",
    contrast: "standard",
  },
  typography: {
    body: {
      family: "IBM Plex Mono",
      fallbacks: "SFMono-Regular, Consolas, ui-monospace, monospace",
    },
    heading: {
      family: "Fraunces",
      fallbacks: "Iowan Old Style, Baskerville, Georgia, serif",
      weight: "semibold",
    },
    code: {
      family: "IBM Plex Mono",
      fallbacks: "SFMono-Regular, Consolas, ui-monospace, monospace",
    },
  },
  radius: {base: 4, multiplier: 0.5},
});


export const recapEditorTheme = defineTheme({
  name: "recap-editor",
  extends: neutralTheme,
  color: {accent: ["#6255e7", "#9386ff"], neutralStyle: "cool"},
  typography: {
    body: {family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},
    heading: {family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", weight: "semibold"},
  },
  radius: {base: 4, multiplier: 1},
  tokens: {
    "--color-background-body": ["#f6f7fb", "#101421"],
    "--color-background-surface": ["#ffffff", "#1b2133"],
    "--color-background-muted": ["#eef0f8", "#242b40"],
    "--color-text-primary": ["#172033", "#eef0fa"],
    "--color-text-secondary": ["#536078", "#a6afc6"],
  },
});
