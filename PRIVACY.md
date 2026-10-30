# Privacy

Trip Recap reads media metadata that may contain precise GPS coordinates and capture times.

## Default behavior

- Photos and videos are read in the browser and are never uploaded. Previews use temporary
  object URLs that disappear when the tab closes.
- Extracted metadata, routes, place names and exported videos live only in the tab's memory.
  Nothing is written to `localStorage`, cookies or a server.
- To infer roads, the browser sends the coordinates of consecutive points to the public OSRM
  router. To label places and look up typed endpoints, it sends coordinates and search text to
  Nominatim. Map tiles come from OpenFreeMap and EOX. These services see your IP address and
  those requests, under their own policies.
- There are no accounts, analytics or location history.

## Self-hosting

To keep coordinates away from third-party services, run your own OSRM and Nominatim and point
the `baseUrl` options in `src/lib/engine/routing.ts` and `src/lib/engine/places.ts`
at them.
