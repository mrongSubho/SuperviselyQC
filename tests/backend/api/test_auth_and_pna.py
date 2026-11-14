from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import EngineSettings


def test_health_unauthenticated_and_token_required_elsewhere(
    api_client: TestClient, test_settings: EngineSettings
) -> None:
    health = api_client.get("/api/v1/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["device"] in {"mps", "cpu"}
    assert "cacheStats" in body

    # Protected routes reject missing/bad token
    assert api_client.get("/api/v1/profiles").status_code == 401
    assert (
        api_client.get(
            "/api/v1/profiles", headers={"X-QC-Bridge-Token": "wrong-token"}
        ).status_code
        == 401
    )

    ok_profiles = api_client.get(
        "/api/v1/profiles",
        headers={"X-QC-Bridge-Token": test_settings.bridge_token or ""},
    )
    assert ok_profiles.status_code == 200


def test_cors_and_pna_headers(api_client: TestClient) -> None:
    allowed_origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    preflight = api_client.options(
        "/api/v1/qc/analyze",
        headers={
            "Origin": allowed_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert preflight.status_code == 204
    assert preflight.headers.get("access-control-allow-origin") == allowed_origin
    assert preflight.headers.get("access-control-allow-private-network") == "true"

    # Unconfigured extension and random web origin are strictly blocked
    for bad_origin in (
        "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "https://evil.example.com",
    ):
        res = api_client.options(
            "/api/v1/qc/analyze",
            headers={
                "Origin": bad_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert res.status_code == 403


def test_websocket_rejects_unauthorized_token_with_4001(
    api_client: TestClient, test_settings: EngineSettings
) -> None:
    from starlette.websockets import WebSocketDisconnect

    try:
        with api_client.websocket_connect("/api/v1/qc/ws/test_client?token=invalid") as ws:
            ws.receive_text()
        raise AssertionError("Expected unauthorized WebSocket disconnect")
    except WebSocketDisconnect as exc:
        assert exc.code == 4001

    with api_client.websocket_connect(
        f"/api/v1/qc/ws/test_client?token={test_settings.bridge_token}"
    ) as ws:
        msg = ws.receive_json()
        assert msg["eventType"] == "ping"
