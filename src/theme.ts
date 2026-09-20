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
