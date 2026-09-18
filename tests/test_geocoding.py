from pathlib import Path

import httpx

from app.geocoding.nominatim import NominatimReverseGeocoder, general_place_name


def test_general_place_name_prefers_locality_and_region() -> None:
    assert (
        general_place_name(
            {
                "address": {
                    "town": "Charikot",
                    "state_district": "Dolakha",
                    "state": "Bagmati Province",
                }
            }
        )
        == "Charikot, Dolakha"
    )


def test_reverse_geocoder_caches_result(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "address": {
                    "city": "Kathmandu",
                    "state": "Bagmati Province",
                }
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        geocoder = NominatimReverseGeocoder(
            tmp_path,
            base_url="https://nominatim.test",
            min_interval_seconds=0,
            client=client,
        )
        first = geocoder.reverse(27.7172, 85.3240)
        second = geocoder.reverse(27.7172, 85.3240)

    assert first == "Kathmandu, Bagmati Province"
    assert second == first
    assert calls == 1
