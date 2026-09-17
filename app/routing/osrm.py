from __future__ import annotations

import asyncio
import httpx

from app.models.route import Coordinate, RouteSegment
from app.routing.cache import RouteCache


class OSRMRouter:
    def __init__(self, base_url: str = "https://router.project-osrm.org", profile: str = "driving", client: httpx.AsyncClient | None = None, cache: RouteCache | None = None, timeout_seconds: float = 20, max_attempts: int = 3) -> None:
        self.base_url=base_url.rstrip("/"); self.profile=profile; self.client=client; self.cache=cache; self.timeout_seconds=timeout_seconds; self.max_attempts=max(1,max_attempts)

    async def route(self, start: Coordinate, end: Coordinate, start_observation_id: str, end_observation_id: str) -> RouteSegment:
        if self.cache:
            cached=self.cache.get(start,end,self.profile)
            if cached is not None:
                return cached.model_copy(update={"start_observation_id":start_observation_id,"end_observation_id":end_observation_id})
        path=f"/route/v1/{self.profile}/{start.longitude},{start.latitude};{end.longitude},{end.latitude}"
        params={"overview":"full","geometries":"geojson","steps":"false"}
        owns_client=self.client is None; client=self.client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            payload=None
            for attempt in range(self.max_attempts):
                try:
                    response=await client.get(f"{self.base_url}{path}",params=params,timeout=self.timeout_seconds)
                    response.raise_for_status(); payload=response.json(); break
                except (httpx.TimeoutException,httpx.NetworkError,httpx.HTTPStatusError):
                    if attempt+1>=self.max_attempts: raise
                    await asyncio.sleep(0.5*(2**attempt))
        finally:
            if owns_client: await client.aclose()
        routes=(payload or {}).get("routes") or []
        if (payload or {}).get("code")!="Ok" or not routes: raise ValueError(f"OSRM did not return a route: {(payload or {}).get('code')}")
        route=routes[0]; coordinates=route.get("geometry",{}).get("coordinates") or []
        if len(coordinates)<2: raise ValueError("OSRM returned an invalid route geometry")
        segment=RouteSegment(start_observation_id=start_observation_id,end_observation_id=end_observation_id,geometry=[Coordinate(longitude=lon,latitude=lat) for lon,lat in coordinates],distance_meters=float(route.get("distance") or 0),duration_seconds=float(route.get("duration") or 0),routing_profile=self.profile,inferred=True)
        if self.cache: self.cache.put(start,end,segment)
        return segment
