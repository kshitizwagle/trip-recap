"use client";

import {Theme} from "@astryxdesign/core/theme";
import type {ReactNode} from "react";
import {designTheme} from "@kshitizwagle/design/astryx";

export default function TripTheme({children}: {children: ReactNode}) {
  return <Theme theme={designTheme} mode="dark">{children}</Theme>;
}
