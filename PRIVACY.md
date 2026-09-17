# Privacy

Trip Recap processes media metadata that may contain precise GPS coordinates and capture times.

## Default behavior

- Uploaded files are stored only in temporary application storage.
- Extracted GPS coordinates and derived route data are stored only for the active trip lifetime.
- Trip media, route data, render artifacts, and route-cache entries are subject to the configured TTL. The default TTL is one hour.
- Old temporary data is removed opportunistically when new analysis requests arrive.
- The application does not require accounts or intentionally build a persistent location history.

## Hosting note

Temporary storage is local to the running application instance. Hosted platforms may restart or replace that instance at any time. Do not treat the current storage layer as durable storage.

## Configuration

`TRIP_RECAP_DATA_TTL_SECONDS` controls the default retention window. Production deployments should use the shortest practical TTL and should add infrastructure-level lifecycle rules if persistent object storage is introduced later.
