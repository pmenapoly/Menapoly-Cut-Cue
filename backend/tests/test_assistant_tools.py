"""The new Claude tools run against real project data (Claude itself is mocked: no API key here)."""
import json

from conftest import upload, wait_jobs

from cutcue.assistant import TOOLS, Assistant


def setup(client, services, fixture_dir):
    pid = client.post("/api/projects", json={"name": "Tools"}).json()["id"]
    asset = upload(client, pid, fixture_dir / "market-mocha-podcast.mp4", chunk=8 * 1024 * 1024)
    upload(client, pid, fixture_dir / "market-mocha-brief.txt")
    wait_jobs(services)
    return pid, asset, Assistant(services, client=object())


def test_tool_schemas_are_well_formed():
    names = [t["name"] for t in TOOLS]
    assert len(names) == len(set(names))
    for t in TOOLS:
        assert t["input_schema"]["type"] == "object" and t["input_schema"].get("additionalProperties") is False
    assert {"auto_edit_podcast", "find_clip_candidates", "create_clips", "get_brief_requirements",
            "set_brief_requirements", "check_brief_compliance", "get_speakers"} <= set(names)


def test_brief_and_speaker_tools(client, services, fixture_dir):
    pid, asset, bot = setup(client, services, fixture_dir)
    created = []
    text, err = bot.run_tool(pid, "get_brief_requirements", {}, created)
    assert not err and "<untrusted_brief_requirements>" in text and '"count": 2' in text
    text, err = bot.run_tool(pid, "set_brief_requirements", {"must_avoid": ["secret"], "cta": "Subscribe"}, created)
    assert not err and services.project_brief(pid)["override_source"] == "claude"
    text, err = bot.run_tool(pid, "set_brief_requirements", {"deliverables": [{"kind": "clip", "count": 99, "aspect": "9:16"}]}, created)
    assert not err and services.project_brief(pid)["requirements"]["deliverables"][0]["count"] == 20  # clamped
    speakers = json.loads(bot.run_tool(pid, "get_speakers", {"asset_id": asset["id"]}, created)[0])
    assert set(speakers["labels"]) == {"S1", "S2"}
    assert "brief: deliverables" in bot.project_state(pid) and "speakers in" in bot.project_state(pid)


def test_auto_edit_and_clip_tools_create_pending_proposals(client, services, fixture_dir):
    pid, asset, bot = setup(client, services, fixture_dir)
    created = []
    out, err = bot.run_tool(pid, "auto_edit_podcast", {"asset_id": asset["id"], "add_hook": True}, created)
    result = json.loads(out)
    assert not err and result["status"] == "pending_user_approval" and "pauses tightened" in result["summary"]
    assert "brief_compliance" in result["sequences"][0]
    proposal = services.get_proposal(pid, created[0])
    assert proposal["created_by"] == "claude" and proposal["plan"]["sequences"][0]["timeline"]["clips"][0]["label"] == "Hook"

    found = json.loads(bot.run_tool(pid, "find_clip_candidates", {"count": 2, "min_s": 10, "max_s": 30}, created)[0])
    assert found["candidates"] and all(c["reasons"] for c in found["candidates"])
    pick = found["candidates"][0]
    out, err = bot.run_tool(pid, "create_clips", {"ranges": [{"start": pick["start"], "end": pick["end"]}], "titles": True}, created)
    assert not err
    clip = services.get_proposal(pid, created[-1])["plan"]["sequences"][0]
    assert clip["timeline"]["aspect"] == "9:16" and clip["timeline"]["title"]
    assert pick["start"] - 0.2 <= clip["timeline"]["clips"][0]["start"] and clip["timeline"]["clips"][-1]["end"] <= pick["end"] + 0.4
    assert services.list_sequences(pid) == []  # nothing applied without approval

    out, err = bot.run_tool(pid, "create_clips", {"ranges": [{"start": 9999, "end": 10010}]}, created)
    assert err and "No transcript" in out


def test_compliance_tool_on_approved_sequence(client, services, fixture_dir):
    pid, asset, bot = setup(client, services, fixture_dir)
    created = []
    bot.run_tool(pid, "auto_edit_podcast", {"asset_id": asset["id"]}, created)
    services.approve_proposal(pid, created[0], render_preview=False)
    seq = services.list_sequences(pid)[0]
    result = json.loads(bot.run_tool(pid, "check_brief_compliance", {"sequence_id": seq["id"]}, created)[0])
    assert result["checks"] and result["deliverable"]["kind"] == "full"
