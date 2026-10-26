# Trip Recap

Turn original photos and videos into an animated route map and a vertical MP4, using the
capture times and GPS metadata already inside them. Missing metadata stays explicit; roads
between recorded points are inferred and drawn differently.

Everything runs in the browser. The app is a static Next.js export that deploys to
Cloudflare Pages (or any static host) with no server, database or API key.

- `frontend/`: the app. Next.js static export with Astryx (Aura Dark theme), Sonner and MapLibre.
- `frontend/src/lib/engine/`: the pipeline as plain TypeScript, ported from the original backend:
  - `metadata/`: EXIF reader for JPEG, HEIC/HEIF, PNG and WebP, and QuickTime/MP4 dates and GPS
  - `trip.ts`: speed checks, clustering into observations, trip segmentation
  - `routing.ts`: router abstraction and the OSRM client (routes are marked `inferred`)
  - `timeline.ts`: deterministic, compressed video timeline shared by preview and export
  - `places.ts`: Nominatim place names and search, throttled to one request per second
  - `mp4.ts`: a small MP4 writer for the H.264 frames WebCodecs produces
- `frontend/src/lib/recap-export.ts`: renders the 1080 × 1920, 30 FPS MP4 frame by frame in the browser.
- `backend/`: the previous FastAPI implementation, kept for reference. The app no longer calls it.

## What leaves the device

Media files are never uploaded. The browser sends coordinates only to the public
[OSRM](https://project-osrm.org/) demo router (to infer roads), to
[Nominatim](https://nominatim.org/) (for place names and endpoint search) and requests
map tiles from [OpenFreeMap](https://openfreemap.org/) and EOX. See [PRIVACY.md](PRIVACY.md).

The public OSRM and Nominatim services are fine for personal use. For heavier traffic, point
`OSRMRouter` and `NominatimGeocoder` (in `frontend/src/lib/engine/`) at your own instances.

## Develop

```sh
cd frontend
npm ci --ignore-scripts
npm run dev        # http://localhost:3000
npm test           # engine + client tests, no network needed
npm run typecheck
npm run build      # static site in frontend/out
```

See [deployment instructions](docs/deployment.md) for Cloudflare Pages.

## Browser support

Metadata reading, routing and preview work in any current browser. MP4 export needs
WebCodecs H.264 encoding: recent Chrome, Edge and Safari. HEIC previews show in Safari;
other browsers still read HEIC metadata but show a placeholder instead of the image.
