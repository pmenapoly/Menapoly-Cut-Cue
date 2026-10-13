"""Claude tool loop, driven by a scripted fake client (no network, no API key).

Checks grounding (tools return real transcript data), validation feedback (a bad
timestamp comes back as an is_error tool_result), and that only a pending proposal is
created: nothing changes until the user approves.
"""
from types import SimpleNamespace

from conftest import upload, wait_jobs

from cutcue.assistant import Assistant


class Block(SimpleNamespace):
    def to_dict(self):
        return {k: v for k, v in vars(self).items()}


def text(t):
    return Block(type="text", text=t)


def tool(id_, name, inp):
    return Block(type="tool_use", id=id_, name=name, input=inp)


class FakeMessages:
    def __init__(self, script):
        self.script, self.calls = script, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        step = self.script[len(self.calls) - 1]
        content = step(kwargs) if callable(step) else step
        stop = "tool_use" if any(b.type == "tool_use" for b in content) else "end_turn"
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_creation_input_tokens=0, cache_read_input_tokens=0)
        return SimpleNamespace(content=content, stop_reason=stop, usage=usage)


class FakeClient:
    def __init__(self, script):
        self.beta = SimpleNamespace(messages=FakeMessages(script))


def test_claude_loop_grounded_and_validated(client, services, fixture_dir):
    pid = client.post("/api/projects", json={"name": "Market Mocha Test"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    vid = video["id"]
    segs = services.transcript(vid)
    hook = next(s for s in segs if s["text"].startswith("Consistency"))

    def after_search(kwargs):
        last = kwargs["messages"][-1]["content"][0]
        assert last["type"] == "tool_result" and "Consistency beats perfection" in last["content"]
        return [tool("t2", "propose_edit", {"title": "Hook", "rationale": "r", "sequences": [
            {"name": "Hook", "aspect": "16:9", "clips": [{"asset_id": vid, "start": 0, "end": 999}]}]})]

    def after_bad(kwargs):
        last = kwargs["messages"][-1]["content"][0]
        assert last.get("is_error") and "exceeds source duration" in last["content"]
        return [tool("t3", "propose_edit", {"title": "Hook first", "rationale": "Strong line", "sequences": [
            {"name": "Hook first", "aspect": "16:9", "remove_pauses": {"enabled": True},
             "clips": [{"asset_id": vid, "start": hook["start"] - 0.15, "end": hook["end"] + 0.15, "label": "Hook"},
                       {"asset_id": vid, "start": 0, "end": video["duration"], "label": "Main"}]}]})]

    script = [
        [text("Let me look."), tool("t1", "search_project", {"query": "consistency"})],
        after_search,
        after_bad,
        [text("Proposed a hook-first cut; approve it to render.")],
    ]
    fake = FakeClient(script)
    bot = Assistant(services, client=fake)
    result = bot.chat(pid, "Give me a compelling intro")
    assert result["mode"] == "claude" and len(result["proposal_ids"]) == 1
    assert "approve it" in result["reply"]
    assert result["cost_usd"] > 0

    first_call = fake.beta.messages.calls[0]
    assert first_call["model"] == "claude-opus-5-5"
    assert first_call["fallbacks"] == "default"
    assert "<project_state>" in first_call["messages"][0]["content"][0]["text"]

    proposal = services.get_proposal(pid, result["proposal_ids"][0])
    assert proposal["status"] == "pending" and proposal["created_by"] == "claude"
    assert services.list_sequences(pid) == []  # nothing applied before approval

    # History is append-only and replayed on the next turn, ending with the assistant message.
    api = bot._api_messages(pid)
    assert [m["role"] for m in api] == ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]
    shown = bot.history(pid)
    assert [m["role"] for m in shown] == ["user", "assistant"]
    assert services.get_project(pid)["spent_usd"] > 0


def test_budget_cap_blocks_claude(client, services):
    pid = client.post("/api/projects", json={"name": "Budget"}).json()["id"]
    services.update_project(pid, budget_usd=0.0)
    bot = Assistant(services, client=FakeClient([]))
    try:
        bot.chat(pid, "hello")
    except Exception as exc:
        assert "budget" in str(exc).lower()
    else:
        raise AssertionError("expected budget error")
