# Deployment

Trip Recap is a static site. There is nothing to run besides a static file host.

## Cloudflare (Workers static assets)

The repository is set up for Cloudflare Workers Builds:

| Setting | Value |
| --- | --- |
| Root directory | `/` (repository root) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy --assets=./out` |
| Node version | `22` (22.18 or newer) |
| Environment variables | none |

`wrangler.toml` serves `out/` as static assets, so `/` (the studio) and `/recap`
(the same page, kept for older links) resolve to their HTML files.

To deploy from a machine instead:

```sh
npm ci --ignore-scripts
npm run build
npx wrangler deploy --assets=./out
```

Cloudflare Pages or any other static host also works: publish the contents of `out/`.
Do not add `pages_build_output_dir` to `wrangler.toml` while deploying with `wrangler deploy`;
it makes Wrangler treat the project as Pages and stop.

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
`src/lib/engine/routing.ts` and `src/lib/engine/places.ts`.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

Tests use synthetic files built in memory and mocked network responses; they need no personal
media and no live routing or geocoding services.
