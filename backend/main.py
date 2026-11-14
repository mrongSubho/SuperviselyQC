from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import EngineSettings, ensure_bridge_token, ensure_loopback_host  # noqa: E402
from app.main import create_app  # noqa: E402


def main() -> None:
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    settings = EngineSettings()
    ensure_loopback_host(settings.host)
    token = ensure_bridge_token(settings)
    print(
        f"[Supervisely QC] Starting loopback server at http://{settings.host}:{settings.port}\n"
        f"[Supervisely QC] Bridge token file: {settings.resolved_bridge_token_path}\n"
        f"[Supervisely QC] X-QC-Bridge-Token: {token}",
        flush=True,
    )
    app = create_app(settings=settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
