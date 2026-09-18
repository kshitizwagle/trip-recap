from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Literal

import httpx

PlaceGranularity = Literal[
    "specific",
    "neighborhood",
    "city",
    "region",
]


def _first(
    address: dict[str, Any],
    keys: tuple[str, ...],
) -> str | None:
    for key in keys:
        value = address.get(key)
        if value:
            return str(value)
    return None


def _join_distinct(
    first: str | None,
    second: str | None,
) -> str | None:
    if first and second:
        if first.casefold() == second.casefold():
            return first
        return f"{first}, {second}"
    return first or second


def format_place_name(
    payload: dict[str, Any],
    granularity: PlaceGranularity = "neighborhood",
) -> str | None:
    address = payload.get("address") or {}

    city = _first(
        address,
        (
            "city",
            "town",
            "village",
            "municipality",
        ),
    )
    neighborhood = _first(
        address,
        (
            "neighbourhood",
            "quarter",
            "suburb",
            "hamlet",
            "village",
        ),
    )
    district = _first(
        address,
        (
            "state_district",
            "county",
            "district",
        ),
    )
    region = _first(
        address,
        (
            "state",
            "region",
        ),
    )

    if granularity == "specific":
        named_place = payload.get("name")
        specific = (
            str(named_place)
            if named_place
            else _first(
                address,
                (
                    "amenity",
                    "tourism",
                    "shop",
                    "leisure",
                    "building",
                    "road",
                    "pedestrian",
                    "residential",
                    "path",
                    "neighbourhood",
                    "quarter",
                    "suburb",
                ),
            )
        )
        context = neighborhood or city or district
        label = _join_distinct(
            specific,
            context,
        )
        if label:
            return label

    if granularity == "neighborhood":
        local = neighborhood or city
        context = (
            city
            if local and city and local.casefold() != city.casefold()
            else district or region
        )
        label = _join_distinct(
            local,
            context,
        )
        if label:
            return label

    if granularity == "city":
        context = district
        if (
            city
            and district
            and city.casefold() == district.casefold()
        ):
            context = region
        label = _join_distinct(
            city or neighborhood,
            context or region,
        )
        if label:
            return label

    if granularity == "region":
        label = _join_distinct(
            district,
            region,
        )
        if label:
            return label

    display_name = payload.get("display_name")
    if display_name:
        parts = [
            part.strip()
            for part in str(display_name).split(",")
            if part.strip()
        ]
        if parts:
            count = 2 if granularity in {
                "specific",
                "neighborhood",
                "region",
            } else 1
            return ", ".join(parts[:count])

    return None


def general_place_name(
    payload: dict[str, Any],
) -> str | None:
    return format_place_name(
        payload,
        "city",
    )


class NominatimReverseGeocoder:
    def __init__(
        self,
        cache_dir: Path,
        *,
        base_url: str = "https://nominatim.openstreetmap.org",
        user_agent: str = (
            "trip-recap/0.1 "
            "(github.com/kshitizwagle/trip-recap)"
        ),
        min_interval_seconds: float = 1.05,
        timeout_seconds: float = 10,
        client: httpx.Client | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(
            parents=True,
            exist_ok=True,
        )
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self.min_interval_seconds = min_interval_seconds
        self.timeout_seconds = timeout_seconds
        self.client = client
        self._last_request_at = 0.0

    @staticmethod
    def _cache_key(
        latitude: float,
        longitude: float,
    ) -> str:
        return (
            f"{latitude:.5f}_{longitude:.5f}"
            .replace("-", "m")
            .replace(".", "p")
        )

    def _payload(
        self,
        latitude: float,
        longitude: float,
    ) -> dict[str, Any]:
        cache_path = (
            self.cache_dir
            / f"raw_{self._cache_key(latitude, longitude)}.json"
        )

        if cache_path.exists():
            return json.loads(
                cache_path.read_text(
                    encoding="utf-8",
                )
            )

        wait_for = (
            self.min_interval_seconds
            - (
                time.monotonic()
                - self._last_request_at
            )
        )
        if wait_for > 0:
            time.sleep(wait_for)

        owns_client = self.client is None
        client = self.client or httpx.Client(
            headers={
                "User-Agent": self.user_agent,
            },
            timeout=self.timeout_seconds,
        )

        try:
            response = client.get(
                f"{self.base_url}/reverse",
                params={
                    "lat": latitude,
                    "lon": longitude,
                    "format": "jsonv2",
                    "addressdetails": 1,
                    "zoom": 18,
                },
                headers={
                    "User-Agent": self.user_agent,
                },
            )
            self._last_request_at = time.monotonic()
            response.raise_for_status()
            payload = response.json()
        finally:
            if owns_client:
                client.close()

        cache_path.write_text(
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return payload

    def reverse(
        self,
        latitude: float,
        longitude: float,
        *,
        granularity: PlaceGranularity = "neighborhood",
    ) -> str | None:
        payload = self._payload(
            latitude,
            longitude,
        )
        return format_place_name(
            payload,
            granularity,
        )
