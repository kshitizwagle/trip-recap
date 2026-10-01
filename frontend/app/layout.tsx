import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@kshitizwagle/design/tokens.css";
import {fontsHref} from "@kshitizwagle/design";
import type {Metadata} from "next";
import type {ReactNode} from "react";
import TripTheme from "@/components/TripTheme";
import "../src/app/globals.css";

export const metadata: Metadata = {
  title: "Trip Recap — Camera roll to route",
  description: "Reconstruct a trip from the metadata already inside your photos and videos.",
  icons: {icon: "/icon.svg"},
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={fontsHref} />
      </head>
      <body>
        <TripTheme>{children}</TripTheme>
      </body>
    </html>
  );
}
