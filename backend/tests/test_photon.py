from pathlib import Path

import httpx

from app.geocoding.photon import PhotonPlaceSearch


def test_photon_search_returns_labels_coordinates_and_caches(
    tmp_path: Path,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path == "/api/"
        assert request.url.params.get("q") == "Times Square"
        assert request.url.params.get("limit") == "5"
        assert request.url.params.get("lang") == "en"
        return httpx.Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [-73.995, 40.753],
                        },
                        "properties": {
                            "name": "Times Square",
                            "city": "Manhattan",
                            "state": "New York State",
                            "country": "United States",
                            "osm_value": "attraction",
                        },
                    }
                ],
            },
        )

    with httpx.Client(
        transport=httpx.MockTransport(handler)
    ) as client:
        search = PhotonPlaceSearch(
            tmp_path,
            base_url="https://photon.test",
            client=client,
        )
        first = search.search("Times Square", limit=5)
        second = search.search("Times Square", limit=5)

    assert first == [
        {
            "label": (
                "Times Square, Manhattan, "
                "New York State, United States"
            ),
            "latitude": 40.753,
            "longitude": -73.995,
            "type": "attraction",
        }
    ]
    assert second == first
    assert calls == 1


def test_photon_search_ignores_short_queries(
    tmp_path: Path,
) -> None:
    search = PhotonPlaceSearch(tmp_path)
    assert search.search("Pa") == []
