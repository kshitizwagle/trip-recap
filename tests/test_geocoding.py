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


def test_place_name_granularity_returns_single_label() -> None:
    assert format_place_name(SAMPLE, "specific") == "Boudha Stupa"
    assert format_place_name(SAMPLE, "neighborhood") == "Boudha"
    assert format_place_name(SAMPLE, "city") == "Kathmandu"
    assert format_place_name(SAMPLE, "region") == "Kathmandu"


def test_place_name_is_trimmed_before_comma() -> None:
    payload = {
        "name": "Patan Durbar Square, Lalitpur",
        "address": {
            "city": "Lalitpur Metropolitan City, Bagmati Province",
        },
    }

    assert (
        format_place_name(payload, "specific")
        == "Patan Durbar Square"
    )
    assert (
        format_place_name(payload, "city")
        == "Lalitpur Metropolitan City"
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
        == "Charikot"
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
            27.7172,
            85.3240,
            granularity="neighborhood",
        )
        specific = geocoder.reverse(
            27.7172,
            85.3240,
            granularity="specific",
        )

    assert neighborhood == "Boudha"
    assert specific == "Boudha Stupa"
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
        assert request.url.params.get("q") == "Patan Durbar Square"
        assert request.url.params.get("accept-language") == "en"
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "27.6730",
                    "lon": "85.3250",
                    "display_name": "Patan Durbar Square, Lalitpur, Nepal",
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
        first = geocoder.forward("Patan Durbar Square")
        second = geocoder.forward("Patan Durbar Square")

    assert first == {
        "latitude": 27.673,
        "longitude": 85.325,
        "display_name": "Patan Durbar Square, Lalitpur, Nepal",
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
        assert request.url.params.get("q") == "Mahalaxmi"
        assert request.url.params.get("limit") == "3"
        assert request.url.params.get("format") == "jsonv2"
        assert request.url.params.get("addressdetails") == "1"
        assert request.url.params.get("accept-language") == "en"
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "27.6939",
                    "lon": "85.3161",
                    "display_name": "Mahalaxmi, Lalitpur, Nepal",
                },
                {
                    "lat": "27.7000",
                    "lon": "85.3200",
                    "display_name": "Mahalaxmi Temple, Kathmandu, Nepal",
                },
                {
                    "lat": "27.7100",
                    "lon": "85.3300",
                    "display_name": "Mahalaxmi Municipality, Nepal",
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
        first = geocoder.search("  Mahalaxmi  ", limit=3)
        second = geocoder.search("Mahalaxmi", limit=3)

    expected = [
        {
            "latitude": 27.6939,
            "longitude": 85.3161,
            "display_name": "Mahalaxmi, Lalitpur, Nepal",
        },
        {
            "latitude": 27.7,
            "longitude": 85.32,
            "display_name": "Mahalaxmi Temple, Kathmandu, Nepal",
        },
        {
            "latitude": 27.71,
            "longitude": 85.33,
            "display_name": "Mahalaxmi Municipality, Nepal",
        },
    ]
    assert first == expected
    assert second == expected
    assert calls == 1
