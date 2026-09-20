"use client";

import {Theme} from "@astryxdesign/core/theme";
import type {ReactNode} from "react";
import {tripRecapTheme} from "@/theme";

export default function TripTheme({children}: {children: ReactNode}) {
  return <Theme theme={tripRecapTheme} mode="dark">{children}</Theme>;
}
