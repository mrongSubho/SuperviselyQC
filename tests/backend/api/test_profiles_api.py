from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import EngineSettings


def test_profile_priority_crud_and_builtin_protection(
    api_client: TestClient, test_settings: EngineSettings
) -> None:
    headers = {"X-QC-Bridge-Token": test_settings.bridge_token or ""}

    # 1. Job title regex matching
    list_res = api_client.get(
        "/api/v1/profiles?jobTitle=Bounding%20Box_Task1_Nov%2012", headers=headers
    )
    assert list_res.status_code == 200
    assert list_res.json()["matchedProfileId"] == "quantigo-street-bbox-v1"

    # 2. Create custom profile with projectIds and datasetIds matchers
    proj_profile = {
        "profileId": "custom-proj",
        "name": "Project Matcher",
        "description": "Matches project 11402",
        "isBuiltin": False,
        "matchers": {"jobTitleRegex": None, "projectIds": ["11402"], "datasetIds": []},
    }
    ds_profile = {
        "profileId": "custom-ds",
        "name": "Dataset Matcher",
        "description": "Matches dataset 38357",
        "isBuiltin": False,
        "matchers": {"jobTitleRegex": None, "projectIds": [], "datasetIds": ["38357"]},
    }
    assert api_client.put("/api/v1/profiles/custom-proj", json=proj_profile, headers=headers).status_code == 200
    assert api_client.put("/api/v1/profiles/custom-ds", json=ds_profile, headers=headers).status_code == 200

    # Priority: datasetIds > projectIds > jobTitleRegex > default
    m_ds = api_client.get(
        "/api/v1/profiles?projectId=11402&datasetId=38357&jobTitle=Bounding%20Box",
        headers=headers,
    )
    assert m_ds.json()["matchedProfileId"] == "custom-ds"

    m_proj = api_client.get(
        "/api/v1/profiles?projectId=11402&datasetId=999&jobTitle=Bounding%20Box",
        headers=headers,
    )
    assert m_proj.json()["matchedProfileId"] == "custom-proj"

    # Built-in DELETE returns 400
    del_builtin = api_client.delete("/api/v1/profiles/default", headers=headers)
    assert del_builtin.status_code == 400

    # Missing profile returns 404
    missing = api_client.get("/api/v1/profiles/does-not-exist", headers=headers)
    assert missing.status_code == 404

    # Custom DELETE returns 204
    del_custom = api_client.delete("/api/v1/profiles/custom-ds", headers=headers)
    assert del_custom.status_code == 204
