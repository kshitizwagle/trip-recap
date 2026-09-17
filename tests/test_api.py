from fastapi.testclient import TestClient

from app.api.app import api

client = TestClient(api)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_preview_contains_maplibre() -> None:
    response = client.get("/preview")
    assert response.status_code == 200
    assert "maplibre-gl" in response.text
    assert "Analyze trip" in response.text
