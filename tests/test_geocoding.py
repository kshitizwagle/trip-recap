from pathlib import Path

import httpx

from app.geocoding.nominatim import (
    NominatimReverseGeocoder,
    format_place_name,
    general_place_name,
)


SAMPLE = {
    "name": "Boudha Stupa",
    "display_name": (
        "Boudha Stupa, Boudha, Kathmandu, "
        "Bagmati Province, Nepal"
    ),
    "address": {
        "road": "Boudha Road",
        "neighbourhood": "Boudha",
        "city": "Kathmandu",
        "state_district": "Kathmandu",
        "state": "Bagmati Province",
    },
}


def test_place_name_granularity() -> None:
    assert (
        format_place_name(
            SAMPLE,
            "specific",
        )
        == "Boudha Stupa, Boudha"
    )
    assert (
        format_place_name(
            SAMPLE,
            "neighborhood",
        )
        == "Boudha, Kathmandu"
    )
    assert (
        format_place_name(
            SAMPLE,
            "city",
        )
        == "Kathmandu, Bagmati Province"
    )
    assert (
        format_place_name(
            SAMPLE,
            "region",
        )
        == "Kathmandu, Bagmati Province"
    )


def test_general_place_name_keeps_city_behavior() -> None:
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


def test_reverse_geocoder_caches_raw_payload(
    tmp_path: Path,
) -> None:
    calls = 0

    def handler(
        request: httpx.Request,
    ) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json=SAMPLE,
        )

    with httpx.Client(
        transport=httpx.MockTransport(handler)
    ) as client:
        geocoder = NominatimReverseGeocoder(
            tmp_path,
            base_url="https://nominatim.test",
            min_interval_seconds=0,
            client=client,
        )

        neighborhood = geocoder.reverse(
            27.7172,
            85.3240,
            granularity="neighborhood",
        )
        specific = geocoder.reverse(
            27.7172,
            85.3240,
            granularity="specific",
        )

    assert neighborhood == "Boudha, Kathmandu"
    assert specific == "Boudha Stupa, Boudha"
    assert calls == 1
