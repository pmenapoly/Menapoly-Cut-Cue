"""The phone-triggered pilot workflow must be manual-only, branch-locked, approval-gated and fail closed."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CP = ROOT / "cloud" / "control-plane"
WF = yaml.safe_load((ROOT / ".github" / "workflows" / "pilot.yml").read_text())
sys.path.insert(0, str(ROOT / "cloud" / "control-plane" / "pilot"))
import ci  # noqa: E402
import preflight  # noqa: E402

ON = WF.get(True) or WF.get("on")  # PyYAML reads the bare key `on` as True


def test_manual_dispatch_only():
    assert list(ON) == ["workflow_dispatch"]
    assert ON["workflow_dispatch"]["inputs"]["action"]["options"] == ["check", "provision", "deploy", "rollback"]
    assert WF["permissions"] == {"contents": "read"}


def test_gate_job_has_no_secrets_and_checks_branch_and_phrase():
    gate = WF["jobs"]["gate"]
    text = yaml.safe_dump(gate)
    assert "secrets." not in text and "environment" not in gate
    script = gate["steps"][0]["run"]
    assert "refs/heads/menapoly-cue-2.0" in script
    for phrase in ("check the pilot", "I approve creating the pilot resources", "I approve deploying the Menapoly Cue pilot",
                   "I approve removing the pilot Worker"):
        assert phrase in script


def test_protected_job_needs_gate_and_environment_and_pins_actions():
    job = WF["jobs"]["pilot"]
    assert job["needs"] == "gate" and job["environment"] == "menapoly-cue-pilot"
    uses = [s["uses"] for s in job["steps"] if "uses" in s]
    assert uses and all(re.search(r"@[0-9a-f]{40}$", u) for u in uses), uses
    checkout = next(s for s in job["steps"] if s.get("uses", "").startswith("actions/checkout"))
    assert checkout["with"] == {"ref": "menapoly-cue-2.0", "persist-credentials": False}
    assert "refs/heads/menapoly-cue-2.0" in job["steps"][0]["run"]


def test_deploy_refuses_without_secrets(monkeypatch):
    for k in ci.DEPLOY_SECRETS + ["D1_DATABASE_ID"]:
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(SystemExit, match="Missing environment secrets"):
        ci.deploy()


def test_ci_config_needs_a_real_database_id():
    with pytest.raises(SystemExit):
        ci.ci_config("not-an-id")


def test_relay_gate_in_ci_fails_closed(monkeypatch):
    class Resp:
        def __init__(self, states): self._s = states
        def raise_for_status(self): pass
        def json(self): return {"workflows": [{"name": n, "state": s} for n, s in self._s.items()]}

    def run(states, token="t"):
        preflight.results.clear()
        monkeypatch.setenv("RELAY_ACTIONS_TOKEN", token)
        monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
        monkeypatch.setattr(preflight.httpx, "get", lambda *a, **k: Resp(states))
        monkeypatch.setattr(sys, "argv", ["preflight.py", "--ci", "--stage", "before-deploy"])
        preflight.main()
        return [r for r in preflight.results if r[1].startswith("Security gate")]

    names = preflight.RELAY_DEPLOY_WORKFLOWS
    assert all(r[0] == preflight.OK for r in run({n: "disabled_manually" for n in names}))
    assert any(r[0] == preflight.BAD for r in run({names[0]: "active", names[1]: "disabled_manually"}))
    preflight.results.clear()
    monkeypatch.delenv("RELAY_ACTIONS_TOKEN")
    monkeypatch.setattr(sys, "argv", ["preflight.py", "--ci", "--stage", "before-deploy"])
    assert preflight.main() == 1 and any("RELAY_ACTIONS_TOKEN" in r[2] for r in preflight.results)


def test_deploy_stage_checks_the_database_secret_not_the_id_free_config(monkeypatch):
    """Regression: in CI the committed wrangler.jsonc has no database_id (ci.py fills it in), so the before-/after-deploy
    preflight must compare the D1_DATABASE_ID secret. Comparing the file failed every deploy and removed the Worker."""
    real = "0f0e0d0c-0b0a-4908-8706-050403020100"
    assert '"database_id"' not in (CP / "wrangler.jsonc").read_text()
    monkeypatch.setenv("D1_DATABASE_ID", real)
    assert preflight.database_id_check(real, ci=True)[0]
    monkeypatch.setenv("D1_DATABASE_ID", "11111111-2222-4333-8444-555555555555")
    assert not preflight.database_id_check(real, ci=True)[0]
    monkeypatch.delenv("D1_DATABASE_ID")
    assert not preflight.database_id_check(real, ci=True)[0]
    assert not preflight.database_id_check("", ci=True)[0]
    assert not preflight.database_id_check(real, ci=False)[0]  # locally the file must carry the id


def test_workflow_refuses_a_private_repository():
    """Environment approvals and environment secrets are ignored if this repository is made private on a free plan;
    the workflow must then refuse instead of running without the owner-approval gate."""
    text = (ROOT / ".github" / "workflows" / "pilot.yml").read_text()
    assert text.count("github.event.repository.private") >= 2


def test_queues_fit_workers_free_retention():
    """Workers Free allows at most 24 h queue retention; every place that creates the queues must ask for that."""
    for f in (CP / "pilot" / "ci.py", CP / "pilot" / "provision.sh", ROOT / "docs" / "cloud" / "setup.md"):
        text = f.read_text()
        creates = re.findall(r"queues.{0,6}create.*", text)
        assert creates and all("86400" in line for line in creates), f


def test_first_check_before_access_is_not_yet_and_later_stages_block(monkeypatch):
    """The first read-only check runs before Access exists: that is "not yet", not a failure. Every later stage fails
    closed on anything "not yet"."""
    preflight.results.clear()
    monkeypatch.setattr(preflight, "CI", True)
    for stage, blocked in (("before-provision", False), ("before-deploy", True), ("after-deploy", True)):
        monkeypatch.setattr(preflight, "STAGE", stage)
        preflight.results[:] = [(preflight.TODO, "CF_ACCESS_TEAM_DOMAIN secret matches the team domain", "set up Access first")]
        assert (preflight.summary() == 1) is blocked, stage
    preflight.results[:] = [(preflight.BAD, "x", "")]
    monkeypatch.setattr(preflight, "STAGE", "before-provision")
    assert preflight.summary() == 1
    preflight.results.clear()


def test_provision_can_be_rerun_after_stopping_half_way():
    assert preflight.resource(exists=True, want=False) == preflight.INFO   # reused by name, not a blocker
    assert preflight.resource(exists=False, want=False) == preflight.OK
    assert preflight.resource(exists=False, want=True) == preflight.TODO   # blocks deploy in CI
    assert preflight.resource(exists=True, want=True) == preflight.OK
