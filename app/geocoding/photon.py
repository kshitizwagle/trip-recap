from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx


class PhotonPlaceSearch:
    def __init__(
        self,
        cache_dir: Path,
        *,
        base_url: str = "https://photon.komoot.io",
        user_agent: str = (
            "trip-recap/0.3 "
            "(github.com/kshitizwagle/trip-recap)"
        ),
        timeout_seconds: float = 10,
        client: httpx.Client | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds
        self.client = client

    @staticmethod
    def _cache_key(query: str, limit: int) -> str:
        raw = f"{query.casefold()}:{limit}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _label(properties: dict[str, Any]) -> str:
        parts: list[str] = []
        street = " ".join(
            str(value).strip()
            for value in (
                properties.get("housenumber"),
                properties.get("street"),
            )
            if value
        ).strip()

        for value in (
            properties.get("name"),
            street,
            properties.get("district"),
            properties.get("city"),
            properties.get("state"),
            properties.get("country"),
        ):
            if not value:
                continue
            text = str(value).strip()
            if text and text not in parts:
                parts.append(text)

        return ", ".join(parts)

    def search(
        self,
        query: str,
        *,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        normalized = " ".join(query.split()).strip()
        if len(normalized) < 3:
            return []

        limit = max(1, min(limit, 8))
        cache_path = (
            self.cache_dir
            / f"photon_{self._cache_key(normalized, limit)}.json"
        )

        if cache_path.exists():
            payload = json.loads(
                cache_path.read_text(encoding="utf-8")
            )
        else:
            owns_client = self.client is None
            client = self.client or httpx.Client(
                headers={"User-Agent": self.user_agent},
                timeout=self.timeout_seconds,
            )
            try:
                response = client.get(
                    f"{self.base_url}/api/",
                    params={
                        "q": normalized,
                        "limit": limit,
                        "lang": "en",
                    },
                    headers={"User-Agent": self.user_agent},
                )
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

        suggestions: list[dict[str, Any]] = []
        for feature in payload.get("features", []):
            geometry = feature.get("geometry") or {}
            coordinates = geometry.get("coordinates") or []
            properties = feature.get("properties") or {}
            if len(coordinates) < 2:
                continue

            try:
                longitude = float(coordinates[0])
                latitude = float(coordinates[1])
            except (TypeError, ValueError):
                continue

            label = self._label(properties)
            if not label:
                continue

            suggestions.append(
                {
                    "label": label,
                    "latitude": latitude,
                    "longitude": longitude,
                    "type": (
                        properties.get("type")
                        or properties.get("osm_value")
                        or "place"
                    ),
                }
            )

        return suggestions
