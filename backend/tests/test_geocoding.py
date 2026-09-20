from pathlib import Path

import httpx

from app.geocoding.nominatim import (
    NominatimReverseGeocoder,
    format_place_name,
    general_place_name,
)


SAMPLE = {
    "name": "Empire State Building",
    "display_name": (
        "Empire State Building, Midtown, New York, "
        "New York State, United States"
    ),
    "address": {
        "road": "Fifth Avenue",
        "neighbourhood": "Midtown",
        "city": "New York",
        "state_district": "New York",
        "state": "New York State",
    },
}


def test_place_name_granularity_returns_single_label() -> None:
    assert format_place_name(SAMPLE, "specific") == "Empire State Building"
    assert format_place_name(SAMPLE, "neighborhood") == "Midtown"
    assert format_place_name(SAMPLE, "city") == "New York"
    assert format_place_name(SAMPLE, "region") == "New York"


def test_place_name_is_trimmed_before_comma() -> None:
    payload = {
        "name": "Times Square, Manhattan",
        "address": {
            "city": "New York City, New York State",
        },
    }

    assert (
        format_place_name(payload, "specific")
        == "Times Square"
    )
    assert (
        format_place_name(payload, "city")
        == "New York City"
    )


def test_general_place_name_keeps_city_behavior() -> None:
    assert (
        general_place_name(
            {
                "address": {
                    "town": "Greenwich",
                    "state_district": "Greater London",
                    "state": "New York State",
                }
            }
        )
        == "Greenwich"
    )


def test_reverse_geocoder_requests_english_and_caches_raw_payload(
    tmp_path: Path,
) -> None:
    calls = 0
    requested_language = None

    def handler(
        request: httpx.Request,
    ) -> httpx.Response:
        nonlocal calls, requested_language
        calls += 1
        requested_language = request.url.params.get(
            "accept-language"
        )
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
            40.7972,
            -73.996,
            granularity="neighborhood",
        )
        specific = geocoder.reverse(
            40.7972,
            -73.996,
            granularity="specific",
        )

    assert neighborhood == "Midtown"
    assert specific == "Empire State Building"
    assert requested_language == "en"
    assert calls == 1


def test_forward_geocoder_returns_coordinates_and_caches(
    tmp_path: Path,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path == "/search"
        assert request.url.params.get("q") == "Times Square"
        assert request.url.params.get("accept-language") == "en"
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "40.753",
                    "lon": "-73.995",
                    "display_name": "Times Square, Manhattan, United States",
                }
            ],
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
        first = geocoder.forward("Times Square")
        second = geocoder.forward("Times Square")

    assert first == {
        "latitude": 40.753,
        "longitude": -73.995,
        "display_name": "Times Square, Manhattan, United States",
    }
    assert second == first
    assert calls == 1


def test_search_geocoder_returns_normalized_results_and_caches(
    tmp_path: Path,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path == "/search"
        assert request.url.params.get("q") == "New York"
        assert request.url.params.get("limit") == "3"
        assert request.url.params.get("format") == "jsonv2"
        assert request.url.params.get("addressdetails") == "1"
        assert request.url.params.get("accept-language") == "en"
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "40.7739",
                    "lon": "-74.0039",
                    "display_name": "New York, Manhattan, United States",
                },
                {
                    "lat": "40.78",
                    "lon": "-74.0",
                    "display_name": "Times Square, New York, United States",
                },
                {
                    "lat": "40.79",
                    "lon": "-73.99",
                    "display_name": "New York City, United States",
                },
            ],
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
        first = geocoder.search("  New York  ", limit=3)
        second = geocoder.search("New York", limit=3)

    expected = [
        {
            "latitude": 40.7739,
            "longitude": -74.0039,
            "display_name": "New York, Manhattan, United States",
        },
        {
            "latitude": 40.78,
            "longitude": -74.0,
            "display_name": "Times Square, New York, United States",
        },
        {
            "latitude": 40.79,
            "longitude": -73.99,
            "display_name": "New York City, United States",
        },
    ]
    assert first == expected
    assert second == expected
    assert calls == 1
