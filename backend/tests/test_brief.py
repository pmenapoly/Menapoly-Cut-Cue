"""Creative Brief Intelligence: extraction (TXT/DOCX/PDF), overrides, compliance and proposals."""
import pytest
from conftest import upload, wait_jobs

import make_fixture
from cutcue.brief import extract_requirements, parse_duration

RICH = """CREATIVE BRIEF – Market Mocha Episode 12

Client: Market Mocha
Audience: small-business founders, 25-45
Platforms: Instagram, YouTube
Deliverables:
- 1 full episode edit for YouTube, under 25 minutes
- 3 vertical Reels, 20-45 seconds each, with captions
- one square teaser for LinkedIn (30-second)
Key messages:
- Consistency beats perfection
- Honest weekly video builds trust
Must include: "doubled our subscription sales"
Avoid: competitor names; pricing
Do not mention the secret.
CTA: Subscribe for weekly roasting tips
Tone: Warm, confident and practical
Deadline: Oct 24
"""


def summary(req):
    return [(d["kind"], d["count"], d["aspect"], d.get("min_s"), d.get("max_s"), d["captions"]) for d in req["deliverables"]]


def test_extracts_structured_requirements():
    req = extract_requirements(RICH)
    assert req["client"] == "Market Mocha"
    assert summary(req) == [("full", 1, "16:9", None, 1500.0, None), ("clip", 3, "9:16", 20.0, 45.0, True),
                            ("clip", 1, "1:1", 18.0, 30.0, None)]
    assert req["key_messages"] == ["Consistency beats perfection", "Honest weekly video builds trust"]
    assert req["must_include"] == ["doubled our subscription sales"]
    assert req["must_avoid"] == ["competitor names", "pricing", "secret"]
    assert req["cta"] == "Subscribe for weekly roasting tips"
    assert req["tone"] == ["warm", "confident", "practical"]
    assert req["platforms"] == ["Instagram", "YouTube"] and req["loudness_target"] == -14.0
    assert {"consistency", "perfection", "doubled", "subscription"} <= set(req["keywords"])


def test_fixture_brief_free_text():
    req = extract_requirements(make_fixture.BRIEF)
    assert summary(req) == [("full", 1, "16:9", None, None, None), ("clip", 2, "9:16", None, None, True)]
    assert req["client"].startswith("Market Mocha")


@pytest.mark.parametrize("text,expected", [
    ("15-45 seconds", {"min_s": 15, "max_s": 45}), ("under 60 seconds", {"max_s": 60}), ("at least 2 minutes", {"min_s": 120}),
    ("30-second", {"min_s": 18, "max_s": 30}), ("10 to 20 mins", {"min_s": 600, "max_s": 1200}), ("no length given", {})])
def test_durations(text, expected):
    assert parse_duration(text) == expected


def test_docx_pdf_txt_extract_the_same(client, services, tmp_path):
    import docx

    txt = tmp_path / "brief.txt"
    txt.write_text(RICH)
    document = docx.Document()
    for line in RICH.splitlines():
        document.add_paragraph(line)
    docx_path = tmp_path / "brief.docx"
    document.save(docx_path)
    pdf_path = tmp_path / "brief.pdf"
    make_fixture.write_pdf(pdf_path, RICH.replace("–", "-"))
    results = {}
    for path in (txt, docx_path, pdf_path):
        pid = client.post("/api/projects", json={"name": path.suffix}).json()["id"]
        asset = upload(client, pid, path)
        assert asset["status"] == "ready", asset
        brief = client.get(f"/api/projects/{pid}/brief").json()
        assert brief["has_brief"] and brief["sources"][0]["asset_id"] == asset["id"]
        results[path.suffix] = brief["requirements"]
    for suffix in (".docx", ".pdf"):
        r = results[suffix]
        assert summary(r) == summary(results[".txt"]), suffix
        for key in ("client", "must_include", "must_avoid", "cta", "key_messages"):
            assert r[key] == results[".txt"][key], (suffix, key)


def test_overrides_merge_and_validate(client):
    pid = client.post("/api/projects", json={"name": "Overrides"}).json()["id"]
    r = client.patch(f"/api/projects/{pid}/brief", json={"fields": {"must_avoid": ["Starbucks"], "cta": "Book a tasting"}}).json()
    assert r["requirements"]["must_avoid"] == ["Starbucks"] and r["override_source"] == "manual"
    assert "tasting" in r["requirements"]["keywords"]
    bad = client.patch(f"/api/projects/{pid}/brief", json={"fields": {"script": "rm -rf /"}})
    assert bad.status_code == 400


def test_compliance_on_real_cuts(client, services, fixture_dir, tmp_path):
    pid = client.post("/api/projects", json={"name": "Compliance"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    brief = tmp_path / "brief.txt"
    brief.write_text(RICH)
    upload(client, pid, brief)
    wait_jobs(services)
    segs = services.transcript(video["id"])
    secret = next(s for s in segs if "secret" in s["text"])
    doubled = next(s for s in segs if "doubled" in s["text"])

    def check(clips, **tl):
        seq = client.post(f"/api/projects/{pid}/sequences", json={"name": "C", "timeline": {"clips": clips, **tl}}).json()
        vid = next(s for s in client.get(f"/api/projects/{pid}/sequences").json() if s["id"] == seq["id"])["current_version_id"]
        result = client.get(f"/api/projects/{pid}/versions/{vid}/compliance").json()
        return {c["check"]: c["status"] for c in result["checks"]}, result

    good, _ = check([{"asset_id": video["id"], "start": segs[2]["start"] - 0.1, "end": doubled["end"] + 0.1}],
                    aspect="9:16", burn_captions=True, audio={"loudness_target": -14})
    assert good["aspect"] == good["duration"] == good["captions"] == good["loudness"] == "pass"
    assert good["include: doubled our subscription sales"] == "pass"
    assert good["avoid: secret"] == "fail"  # "Here is the secret" is spoken in this range

    clean, result = check([{"asset_id": video["id"], "start": doubled["start"] - 0.1, "end": doubled["end"] + 0.1}], aspect="9:16")
    assert clean["avoid: secret"] == "pass"
    assert clean["duration"] == "fail" and clean["captions"] == "fail" and clean["loudness"] == "warn"
    assert result["summary"].startswith(("1 failing", "2 failing", "3 failing"))


def test_proposals_carry_compliance(client, services, fixture_dir):
    pid = client.post("/api/projects", json={"name": "Proposal compliance"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    upload(client, pid, fixture_dir / "market-mocha-brief.pdf")
    wait_jobs(services)
    proposal = client.post(f"/api/projects/{pid}/auto-edit", json={"asset_id": video["id"]}).json()
    comp = proposal["plan"]["sequences"][0]["compliance"]
    assert comp["deliverable"]["kind"] == "full"
    checks = {c["check"]: c for c in comp["checks"]}
    assert checks["aspect"]["status"] == "pass" and checks["key messages"]["status"] == "pass"
    assert proposal["plan"]["sequences"][0]["timeline"]["audio"]["loudness_target"] == -16.0
