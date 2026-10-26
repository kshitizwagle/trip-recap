# Deployment

Trip Recap is a static site. There is nothing to run besides a static file host.

## Cloudflare Pages

Connect this repository with these build settings:

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Framework | Next.js (Static HTML Export) |
| Build command | `npm run build` |
| Output directory | `out` |
| Node version | `22` (22.18 or newer) |
| Environment variables | none |

Pages serves `/` (the studio) and `/recap` (the same page, kept for older links).

Or deploy from a machine with Wrangler:

```sh
cd frontend
npm ci --ignore-scripts
npm run build
npx wrangler pages deploy out --project-name trip-recap
```

Any other static host works the same way: upload the contents of `frontend/out`.

## External services

The browser calls these public services directly. None needs a key.

| Service | Used for | Sent |
| --- | --- | --- |
| `router.project-osrm.org` | inferring roads between points | coordinates of consecutive points |
| `nominatim.openstreetmap.org` | place names and endpoint search | point coordinates, search text |
| `tiles.openfreemap.org` | street map style and tiles | map viewport |
| `tiles.maps.eox.at` | satellite imagery | map viewport |

The public OSRM demo and Nominatim have usage policies meant for light use. If the site gets
real traffic, run your own OSRM or Nominatim and change the `baseUrl` defaults in
`frontend/src/lib/engine/routing.ts` and `frontend/src/lib/engine/places.ts`.

## Legacy backend

`backend/` and `compose.yaml` are the earlier FastAPI service. The frontend does not use them;
they are kept for reference and still have their own tests.

## Verification

```sh
cd frontend
npm test
npm run typecheck
npm run build
```

Tests use synthetic files built in memory and mocked network responses; they need no personal
media and no live routing or geocoding services.
