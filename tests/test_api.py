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
    assert "UPLOAD_CHUNK_BYTES=2*1024*1024" in response.text
    assert "/media/init" in response.text
    assert "/chunks/" in response.text
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


def test_chunked_upload_round_trip() -> None:
    session_id = "7cb3510d-67d1-47c1-95c6-bfbac276fa2e"
    payload = b"trip-recap"

    init = client.post(
        f"/api/upload-sessions/{session_id}/media/init",
        json={
            "filename": "photo.jpg",
            "size_bytes": len(payload),
            "chunk_size_bytes": 256 * 1024,
        },
    )
    assert init.status_code == 201
    upload_id = init.json()["id"]
    assert init.json()["total_chunks"] == 1

    chunk = client.put(
        (
            f"/api/upload-sessions/{session_id}/media/"
            f"{upload_id}/chunks/0"
        ),
        content=payload,
        headers={"content-type": "application/octet-stream"},
    )
    assert chunk.status_code == 204

    complete = client.post(
        (
            f"/api/upload-sessions/{session_id}/media/"
            f"{upload_id}/complete"
        )
    )
    assert complete.status_code == 200
    assert complete.json()["state"] == "uploaded"
    assert complete.json()["stored_bytes"] == len(payload)

    status = client.get(
        (
            f"/api/upload-sessions/{session_id}/media/"
            f"{upload_id}/status"
        )
    )
    assert status.status_code == 200
    assert status.json()["state"] == "uploaded"

    discarded = client.delete(
        f"/api/upload-sessions/{session_id}/media/{upload_id}"
    )
    assert discarded.status_code == 200


def test_chunked_upload_rejects_files_over_25_mb() -> None:
    session_id = "38c9fb46-dd93-4f04-bcdf-81896551118d"
    response = client.post(
        f"/api/upload-sessions/{session_id}/media/init",
        json={
            "filename": "too-large.mov",
            "size_bytes": 25 * 1024 * 1024 + 1,
            "chunk_size_bytes": 2 * 1024 * 1024,
        },
    )

    assert response.status_code == 413
    assert "File too large" in response.json()["detail"]
