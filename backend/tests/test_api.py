from fastapi.testclient import TestClient

from app.config import settings
from app.api.app import api

client = TestClient(api)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_backend_does_not_serve_frontend() -> None:
    for path in ("/", "/recap", "/preview", "/icon.svg", "/_next/missing.js"):
        assert client.get(path).status_code == 404


def test_cors_preflight() -> None:
    for origin, status in (("http://localhost:3000", 200), ("https://untrusted.example", 400)):
        response = client.options("/api/trips/analyze-session", headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        })
        assert response.status_code == status
        assert response.headers.get("access-control-allow-origin") == (origin if status == 200 else None)


def test_render_uses_configured_frontend_url(monkeypatch) -> None:
    captured: dict[str, str] = {}

    monkeypatch.setattr("app.api.app._trip_or_404", lambda trip_id: object())
    monkeypatch.setattr(
        "app.api.app.render_service.create_job",
        lambda trip_id: "render-id",
    )

    async def fake_run(render_id: str, trip_id: str, preview_url: str) -> None:
        captured["preview_url"] = preview_url

    monkeypatch.setattr("app.api.app.render_service.run", fake_run)
    response = client.post("/api/trips/trip-id/render")

    assert response.status_code == 202
    assert captured["preview_url"] == settings.render_preview_url


def test_public_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_location_search_returns_geocoder_suggestions(monkeypatch) -> None:
    class FakeGeocoder:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def search(self, query: str, limit: int = 5) -> list[dict]:
            assert query == "New York"
            assert limit == 3
            return [
                {
                    "latitude": 40.7739,
                    "longitude": -74.0039,
                    "display_name": "New York, Manhattan, United States",
                }
            ]

    monkeypatch.setattr("app.api.app.NominatimReverseGeocoder", FakeGeocoder)

    response = client.get(
        "/api/locations/search",
        params={"q": "New York", "limit": 3},
    )

    assert response.status_code == 200
    assert response.json() == {
        "results": [
            {
                "latitude": 40.7739,
                "longitude": -74.0039,
                "display_name": "New York, Manhattan, United States",
            }
        ]
    }


def test_location_search_validates_query_and_limit() -> None:
    assert client.get(
        "/api/locations/search",
        params={"q": "M"},
    ).status_code == 422
    assert client.get(
        "/api/locations/search",
        params={"q": "New York", "limit": 6},
    ).status_code == 422
