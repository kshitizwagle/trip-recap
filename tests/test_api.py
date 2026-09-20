from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.api.app import api

client = TestClient(api)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root_serves_intro_page() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "Make a trip out of the camera roll." in response.text
    assert "Start a recap" in response.text
    assert 'href="/recap"' in response.text
    assert 'id="upload-card"' not in response.text
    assert "/_next/static/" in response.text


def test_recap_serves_workspace_page() -> None:
    response = client.get("/recap")
    assert response.status_code == 200
    assert "Determine route from retained media" in response.text
    assert 'id="upload-card"' in response.text
    assert 'id="drop-zone"' in response.text
    assert 'id="media-grid"' in response.text
    assert 'id="start-point"' in response.text
    assert 'id="end-point"' in response.text
    assert 'id="vehicle"' in response.text
    assert 'role="combobox"' in response.text
    assert 'id="place-detail"' in response.text


def test_preview_alias_serves_workspace_page() -> None:
    response = client.get("/preview")
    assert response.status_code == 200
    assert "Determine route from retained media" in response.text
    assert 'id="upload-card"' in response.text


def test_docker_frontend_build_includes_workspace_route() -> None:
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text()
    assert "COPY app/recap ./app/recap" in dockerfile
    assert "COPY app/icon.svg ./app/icon.svg" in dockerfile


def test_result_toolbar_exposes_place_detail_control() -> None:
    source = (Path(__file__).parents[1] / "src/components/trip-recap/TripRecapPage.tsx").read_text()
    toolbar = source.split('id="map-controls"', 1)[1]
    assert 'id="place-detail"' in toolbar


def test_favicon_is_served() -> None:
    response = client.get("/favicon.png")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")


def test_app_icon_is_served() -> None:
    response = client.get("/icon.svg")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")


def test_render_uses_internal_preview_url(monkeypatch) -> None:
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
            assert query == "Mahalaxmi"
            assert limit == 3
            return [
                {
                    "latitude": 27.6939,
                    "longitude": 85.3161,
                    "display_name": "Mahalaxmi, Lalitpur, Nepal",
                }
            ]

    monkeypatch.setattr("app.api.app.NominatimReverseGeocoder", FakeGeocoder)

    response = client.get(
        "/api/locations/search",
        params={"q": "Mahalaxmi", "limit": 3},
    )

    assert response.status_code == 200
    assert response.json() == {
        "results": [
            {
                "latitude": 27.6939,
                "longitude": 85.3161,
                "display_name": "Mahalaxmi, Lalitpur, Nepal",
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
        params={"q": "Mahalaxmi", "limit": 6},
    ).status_code == 422
