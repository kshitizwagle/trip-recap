from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx


def general_place_name(payload: dict[str, Any]) -> str | None:
    address = payload.get("address") or {}

    locality = next(
        (
            address.get(key)
            for key in (
                "city",
                "town",
                "village",
                "municipality",
                "suburb",
                "hamlet",
                "neighbourhood",
                "county",
                "state_district",
            )
            if address.get(key)
        ),
        None,
    )
    region = next(
        (
            address.get(key)
            for key in ("state_district", "state", "region")
            if address.get(key)
        ),
        None,
    )

    if locality and region and locality.casefold() != region.casefold():
        return f"{locality}, {region}"
    if locality:
        return str(locality)
    if region:
        return str(region)

    name = payload.get("name")
    if name:
        return str(name)

    display_name = payload.get("display_name")
    if display_name:
        return str(display_name).split(",", 1)[0].strip() or None
    return None


class NominatimReverseGeocoder:
    def __init__(
        self,
        cache_dir: Path,
        *,
        base_url: str = "https://nominatim.openstreetmap.org",
        user_agent: str = "trip-recap/0.1 (github.com/kshitizwagle/trip-recap)",
        min_interval_seconds: float = 1.05,
        timeout_seconds: float = 10,
        client: httpx.Client | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self.min_interval_seconds = min_interval_seconds
        self.timeout_seconds = timeout_seconds
        self.client = client
        self._last_request_at = 0.0

    @staticmethod
    def _cache_key(latitude: float, longitude: float) -> str:
        return f"{latitude:.5f}_{longitude:.5f}".replace("-", "m").replace(".", "p")

    def reverse(self, latitude: float, longitude: float) -> str | None:
        cache_path = self.cache_dir / f"{self._cache_key(latitude, longitude)}.json"
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            return cached.get("label")

        wait_for = self.min_interval_seconds - (time.monotonic() - self._last_request_at)
        if wait_for > 0:
            time.sleep(wait_for)

        owns_client = self.client is None
        client = self.client or httpx.Client(
            headers={"User-Agent": self.user_agent},
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
                    "zoom": 12,
                },
                headers={"User-Agent": self.user_agent},
            )
            self._last_request_at = time.monotonic()
            response.raise_for_status()
            payload = response.json()
        finally:
            if owns_client:
                client.close()

        label = general_place_name(payload)
        cache_path.write_text(
            json.dumps(
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "label": label,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return label
