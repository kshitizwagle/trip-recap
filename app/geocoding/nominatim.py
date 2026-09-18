from __future__ import annotations

import hashlib
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


def _before_comma(value: str | None) -> str | None:
    if not value:
        return None
    return value.split(",", 1)[0].strip() or None


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
        label = specific or neighborhood or city or district or region
        return _before_comma(label)

    if granularity == "neighborhood":
        return _before_comma(
            neighborhood or city or district or region
        )

    if granularity == "city":
        return _before_comma(
            city or neighborhood or district or region
        )

    if granularity == "region":
        return _before_comma(
            district or region or city or neighborhood
        )

    display_name = payload.get("display_name")
    if display_name:
        return _before_comma(str(display_name))

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
            / f"raw_en_{self._cache_key(latitude, longitude)}.json"
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
                    "accept-language": "en",
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


    def forward(
        self,
        query: str,
    ) -> dict[str, Any] | None:
        normalized = " ".join(query.split()).strip()
        if not normalized:
            return None

        cache_key = hashlib.sha256(
            normalized.casefold().encode("utf-8")
        ).hexdigest()
        cache_path = self.cache_dir / f"search_en_{cache_key}.json"

        if cache_path.exists():
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
        else:
            wait_for = self.min_interval_seconds - (
                time.monotonic() - self._last_request_at
            )
            if wait_for > 0:
                time.sleep(wait_for)

            owns_client = self.client is None
            client = self.client or httpx.Client(
                headers={"User-Agent": self.user_agent},
                timeout=self.timeout_seconds,
            )
            try:
                response = client.get(
                    f"{self.base_url}/search",
                    params={
                        "q": normalized,
                        "format": "jsonv2",
                        "addressdetails": 1,
                        "limit": 1,
                        "accept-language": "en",
                    },
                    headers={"User-Agent": self.user_agent},
                )
                self._last_request_at = time.monotonic()
                response.raise_for_status()
                payload = response.json()
            finally:
                if owns_client:
                    client.close()

            cache_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        if not payload:
            return None

        result = payload[0]
        try:
            latitude = float(result["lat"])
            longitude = float(result["lon"])
        except (KeyError, TypeError, ValueError):
            return None

        return {
            "latitude": latitude,
            "longitude": longitude,
            "display_name": result.get("display_name"),
        }
