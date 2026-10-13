from fastapi.testclient import TestClient

from conftest import upload


def test_rejects_unknown_extension(client):
    pid = client.post("/api/projects", json={"name": "Sec"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/uploads", json={"filename": "evil.sh", "size": 10})
    assert r.status_code == 400


def test_rejects_fake_media(client, tmp_path):
    pid = client.post("/api/projects", json={"name": "Sec"}).json()["id"]
    fake = tmp_path / "notreally.mp4"
    fake.write_bytes(b"this is not a video" * 100)
    up = client.post(f"/api/projects/{pid}/uploads", json={"filename": fake.name, "size": fake.stat().st_size}).json()
    client.put(f"/api/projects/{pid}/uploads/{up['id']}", params={"offset": 0}, content=fake.read_bytes())
    r = client.post(f"/api/projects/{pid}/uploads/{up['id']}/complete")
    assert r.status_code == 400 and "not a readable media file" in r.json()["detail"]
    assert client.get(f"/api/projects/{pid}/assets").json() == []


def test_upload_resume_offsets(client, tmp_path):
    pid = client.post("/api/projects", json={"name": "Sec"}).json()["id"]
    up = client.post(f"/api/projects/{pid}/uploads", json={"filename": "notes.txt", "size": 10}).json()
    assert client.put(f"/api/projects/{pid}/uploads/{up['id']}", params={"offset": 0}, content=b"hello").status_code == 200
    bad = client.put(f"/api/projects/{pid}/uploads/{up['id']}", params={"offset": 0}, content=b"hello")
    assert bad.status_code == 400 and "server has 5" in bad.json()["detail"]
    assert client.get(f"/api/projects/{pid}/uploads/{up['id']}").json()["received"] == 5
    client.put(f"/api/projects/{pid}/uploads/{up['id']}", params={"offset": 5}, content=b"world")
    asset = client.post(f"/api/projects/{pid}/uploads/{up['id']}/complete").json()
    assert asset["kind"] == "document" and asset["status"] == "ready"


def test_ids_are_validated_and_project_scoped(client, tmp_path):
    a = client.post("/api/projects", json={"name": "A"}).json()["id"]
    b = client.post("/api/projects", json={"name": "B"}).json()["id"]
    doc = tmp_path / "brief.txt"
    doc.write_text("brief")
    asset = upload(client, a, doc)
    assert client.get(f"/api/projects/{b}/assets/{asset['id']}").status_code == 404
    assert client.get(f"/api/projects/{a}/assets/..%2F..%2Fetc").status_code == 404
    assert client.get("/api/projects/prj_..%2F..%2F").status_code == 404


def test_password_required_when_configured(settings, services):
    from cutcue.main import create_app

    settings.password = "s3cret"
    with TestClient(create_app(settings, services)) as c:
        assert c.get("/api/projects").status_code == 401
        assert c.get("/api/health").status_code == 200
        assert c.post("/api/auth/login", json={"password": "nope"}).status_code == 401
        assert c.post("/api/auth/login", json={"password": "s3cret"}).status_code == 200
        assert c.get("/api/projects").status_code == 200
