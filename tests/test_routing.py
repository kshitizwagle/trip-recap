import asyncio
from pathlib import Path

import httpx

from app.models.route import Coordinate
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter


def test_osrm_router_parses_geojson_and_uses_cache(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "code": "Ok",
                "routes": [
                    {
                        "distance": 1200.0,
                        "duration": 180.0,
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[85.32, 27.67], [85.33, 27.68]],
                        },
                    }
                ],
            },
        )

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            router = OSRMRouter(base_url="https://router.test", client=client, cache=RouteCache(tmp_path))
            start = Coordinate(latitude=27.67, longitude=85.32)
            end = Coordinate(latitude=27.68, longitude=85.33)
            first = await router.route(start, end, "a", "b")
            second = await router.route(start, end, "a2", "b2")
            assert first.distance_meters == 1200
            assert second.start_observation_id == "a2"
            assert second.end_observation_id == "b2"

    asyncio.run(run())
    assert calls == 1
