import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))


@pytest.fixture(scope="session")
def fixture_dir(tmp_path_factory) -> Path:
    import make_fixture

    out = tmp_path_factory.mktemp("fixture")
    make_fixture.main(out)
    os.environ["CUTCUE_FIXTURE_DIR"] = str(out)
    return out


@pytest.fixture()
def settings(tmp_path, fixture_dir):
    from cutcue.config import Settings

    return Settings(data_dir=tmp_path / "data", transcriber="fixture", anthropic_api_key="", project_budget_usd=5.0)


@pytest.fixture()
def services(settings):
    from cutcue.services import Services

    return Services(settings)


@pytest.fixture()
def client(settings, services):
    from fastapi.testclient import TestClient

    from cutcue.main import create_app

    with TestClient(create_app(settings, services)) as c:
        yield c


def upload(client, pid: str, path: Path, chunk: int = 1024 * 1024) -> dict:
    """Upload through the real chunked API."""
    data = path.read_bytes()
    up = client.post(f"/api/projects/{pid}/uploads", json={"filename": path.name, "size": len(data)})
    assert up.status_code == 201, up.text
    uid = up.json()["id"]
    for offset in range(0, len(data), chunk):
        r = client.put(f"/api/projects/{pid}/uploads/{uid}", params={"offset": offset}, content=data[offset:offset + chunk])
        assert r.status_code == 200, r.text
    done = client.post(f"/api/projects/{pid}/uploads/{uid}/complete")
    assert done.status_code == 200, done.text
    return done.json()


def wait_jobs(services, timeout: float = 300) -> None:
    assert services.jobs.wait_idle(timeout), "jobs did not finish"
    time.sleep(0.1)
