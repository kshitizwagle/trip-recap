from fastapi.testclient import TestClient

from app.api.app import api

client = TestClient(api)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root_contains_fastapi_trip_ui() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "maplibre-gl" in response.text
    assert "Determine route from retained media" in response.text
    assert "/api/trips/analyze-session" in response.text
    assert "MAX_CONCURRENT_UPLOADS=4" in response.text
    assert "MAX_FILE_BYTES=25*1024*1024" in response.text
    assert "Max 25 MB per file" in response.text
    assert "start_location" in response.text
    assert "/api/locations/suggest" in response.text
    assert "start-coordinates" in response.text
    assert "end-coordinates" in response.text
    assert "pollUploadStatus" not in response.text
    assert "availableRetainedUploads" in response.text
    assert "readApiResponse" in response.text
    assert "response.json()" not in response.text
    assert "playback-speed" in response.text
    assert "slow-points" in response.text
    assert "/favicon.png" in response.text


def test_preview_alias_contains_renderer_contract() -> None:
    response = client.get("/preview")
    assert response.status_code == 200
    assert "window.setTripTime" in response.text
    assert "window.tripReady" in response.text


def test_favicon_is_served() -> None:
    response = client.get("/favicon.png")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")


def test_public_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_location_suggestions(monkeypatch) -> None:
    def fake_search(self, query: str, *, limit: int = 5):
        assert query == "Patan"
        assert limit == 5
        return [
            {
                "label": "Patan Durbar Square, Lalitpur, Nepal",
                "latitude": 27.673,
                "longitude": 85.325,
                "type": "attraction",
            }
        ]

    monkeypatch.setattr(
        "app.api.app.PhotonPlaceSearch.search",
        fake_search,
    )

    response = client.get(
        "/api/locations/suggest",
        params={"q": "Patan", "limit": 5},
    )

    assert response.status_code == 200
    assert response.json()["suggestions"][0]["latitude"] == 27.673
    assert response.json()["suggestions"][0]["longitude"] == 85.325


def test_analyze_session_ignores_missing_uploads() -> None:
    response = client.post(
        "/api/trips/analyze-session",
        json={
            "session_id": "4c1b0f15-62e7-4ef2-8c5d-e448e8ad0d63",
            "upload_ids": [
                "d1b8d04d-6cbe-4860-a35b-93fa2f5abfff",
            ],
            "keep_as_one_trip": True,
            "start_location": None,
            "end_location": None,
            "return_to_start": False,
        },
    )

    assert response.status_code == 400
    assert "No available retained uploads" in response.json()["detail"]
    assert response.json()["detail"] != "Upload not found"
