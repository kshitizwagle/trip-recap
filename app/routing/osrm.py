from __future__ import annotations

import httpx

from app.models.route import Coordinate, RouteSegment
from app.routing.cache import RouteCache


class OSRMRouter:
    def __init__(
        self,
        base_url: str = "https://router.project-osrm.org",
        profile: str = "driving",
        client: httpx.AsyncClient | None = None,
        cache: RouteCache | None = None,
        timeout_seconds: float = 20,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.profile = profile
        self.client = client
        self.cache = cache
        self.timeout_seconds = timeout_seconds

    async def route(
        self,
        start: Coordinate,
        end: Coordinate,
        start_observation_id: str,
        end_observation_id: str,
    ) -> RouteSegment:
        if self.cache:
            cached = self.cache.get(start, end, self.profile)
            if cached is not None:
                return cached.model_copy(
                    update={
                        "start_observation_id": start_observation_id,
                        "end_observation_id": end_observation_id,
                    }
                )

        path = (
            f"/route/v1/{self.profile}/"
            f"{start.longitude},{start.latitude};{end.longitude},{end.latitude}"
        )
        params = {"overview": "full", "geometries": "geojson", "steps": "false"}
        owns_client = self.client is None
        client = self.client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            response = await client.get(f"{self.base_url}{path}", params=params)
            response.raise_for_status()
            payload = response.json()
        finally:
            if owns_client:
                await client.aclose()

        routes = payload.get("routes") or []
        if payload.get("code") != "Ok" or not routes:
            raise ValueError(f"OSRM did not return a route: {payload.get('code')}")
        route = routes[0]
        coordinates = route.get("geometry", {}).get("coordinates") or []
        if len(coordinates) < 2:
            raise ValueError("OSRM returned an invalid route geometry")

        segment = RouteSegment(
            start_observation_id=start_observation_id,
            end_observation_id=end_observation_id,
            geometry=[Coordinate(longitude=lon, latitude=lat) for lon, lat in coordinates],
            distance_meters=float(route.get("distance") or 0),
            duration_seconds=float(route.get("duration") or 0),
            routing_profile=self.profile,
            inferred=True,
        )
        if self.cache:
            self.cache.put(start, end, segment)
        return segment
