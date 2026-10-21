"""The phone-triggered pilot workflow must be manual-only, branch-locked, approval-gated and fail closed."""
from __future__ import annotations

import json
import re
import subprocess
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


# --- workers.dev target: Cue behind Access without touching menapoly-digital.com's DNS (Canva site, Zoho email) ---
DB_ID = "0f0e0d0c-0b0a-4908-8706-050403020100"


def _jsonc(text: str) -> dict:
    text = re.sub(r'(?m)^\s*//.*$|\s//\s.*$', "", text)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))


def test_workflow_pins_the_workers_dev_target():
    assert WF["jobs"]["pilot"]["env"]["PILOT_TARGET"] == "workers-dev"
    assert "PILOT_TARGET" not in yaml.safe_dump(WF["jobs"]["gate"])


def test_workers_dev_config_has_no_custom_domain_and_no_previews():
    cfg = _jsonc(ci.config_text(DB_ID, "workers-dev"))
    assert cfg["workers_dev"] is True and cfg["preview_urls"] is False
    assert "routes" not in cfg  # no cue.menapoly-digital.com record is created
    assert cfg["d1_databases"][0]["database_id"] == DB_ID
    custom = _jsonc(ci.config_text(DB_ID, "custom-domain"))
    assert custom["workers_dev"] is False and custom["preview_urls"] is False
    assert custom["routes"] == [{"pattern": "cue.menapoly-digital.com", "custom_domain": True}]


def test_workers_dev_config_is_accepted_by_wrangler(tmp_path):
    """Offline `wrangler deploy --dry-run` of the generated config: nothing is uploaded."""
    out = CP / "wrangler.test-workers-dev.jsonc"
    out.write_text(ci.config_text(DB_ID, "workers-dev"))
    try:
        r = subprocess.run(["npx", "wrangler", "deploy", "--dry-run", "--config", out.name], cwd=CP,
                           capture_output=True, text=True, timeout=300)
    finally:
        out.unlink()
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    assert "--dry-run: exiting now." in r.stdout + r.stderr


def test_r2_cors_allows_only_the_pilot_address(monkeypatch, tmp_path):
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    rules = json.loads(ci.cors_file("menapoly-cue-cloud.example.workers.dev").read_text())["rules"]
    assert rules[0]["allowed"]["origins"] == ["https://menapoly-cue-cloud.example.workers.dev"]


def test_target_must_be_explicit_in_ci(monkeypatch):
    monkeypatch.delenv("PILOT_TARGET", raising=False)
    assert preflight.target_mode(ci=True) == "" and preflight.target_mode(ci=False) == "custom-domain"
    monkeypatch.setenv("PILOT_TARGET", "public")
    assert preflight.target_mode(ci=True) == ""
    with pytest.raises(SystemExit, match="PILOT_TARGET"):
        ci.target()


def test_access_apps_are_matched_on_every_hostname_field():
    host = "menapoly-cue-cloud.example.workers.dev"
    assert host in preflight.app_hosts({"domain": host})
    assert host in preflight.app_hosts({"self_hosted_domains": [f"https://{host}/"]})
    assert f"{host}/v1/worker" in preflight.app_hosts({"destinations": [{"type": "public", "uri": f"{host}/v1/worker"}]})


class _FakeCF:
    """Stands in for the Cloudflare API in preflight: an account with a workers.dev subdomain and both Access apps."""
    def __init__(self, subdomain="pmenapoly", apps=True):
        self.subdomain, self.apps, self.calls = subdomain, apps, []

    def __call__(self, client, path, **params):
        self.calls.append(path)
        host = f"menapoly-cue-cloud.{self.subdomain}.workers.dev"
        if path.endswith("/tokens/verify"):
            return {"status": "active"}
        if path.endswith("/workers/subdomain"):
            if not self.subdomain:
                raise RuntimeError("no subdomain")
            return {"subdomain": self.subdomain}
        if path.endswith("/access/organizations"):
            return {"auth_domain": "menapoly.cloudflareaccess.com"}
        if path.endswith("/access/apps"):
            return [{"id": "a1", "name": "Menapoly Cue", "domain": host, "aud": "aud-1", "type": "self_hosted"},
                    {"id": "a2", "name": "Menapoly Cue – Mac worker", "domain": f"{host}/v1/worker", "type": "self_hosted"}] if self.apps else []
        if path.endswith("/a1/policies"):
            return [{"name": "Owner", "decision": "allow", "include": [{"email": {"email": "owner@example.test"}}]}]
        if path.endswith("/a2/policies"):
            return [{"name": "Mac", "decision": "non_identity", "include": [{"service_token": {"token_id": "t"}}]}]
        raise AssertionError(f"unexpected Cloudflare call {path}")


def _run_preflight(monkeypatch, fake, stage="before-deploy"):
    preflight.results.clear()
    monkeypatch.setenv("PILOT_TARGET", "workers-dev")
    for k, v in {"CLOUDFLARE_ACCOUNT_ID": "acc", "CLOUDFLARE_API_TOKEN": "tok", "RELAY_ACTIONS_TOKEN": "r",
                 "CF_ACCESS_TEAM_DOMAIN": "menapoly.cloudflareaccess.com", "CF_ACCESS_AUD": "aud-1", "D1_DATABASE_ID": DB_ID,
                 "OWNER_EMAILS": "owner@example.test"}.items():
        monkeypatch.setenv(k, v)

    class Resp:
        def raise_for_status(self): pass
        def json(self): return {"workflows": [{"name": n, "state": "disabled_manually"} for n in preflight.RELAY_DEPLOY_WORKFLOWS]}

    monkeypatch.setattr(preflight.httpx, "get", lambda *a, **k: Resp())
    monkeypatch.setattr(preflight, "cf", fake)
    listing = {"d1": f'[{{"name": "menapoly-cue-cloud", "uuid": "{DB_ID}"}}]', "r2": "name: menapoly-cue-media",
               "queues": "menapoly-cue-events menapoly-cue-events-dlq"}
    monkeypatch.setattr(preflight, "wrangler", lambda *a: (0, listing.get(a[0], "disabled")))
    monkeypatch.setattr(sys, "argv", ["preflight.py", "--ci", "--stage", stage])
    code = preflight.main()
    return code, list(preflight.results)


def test_preflight_workers_dev_ready_needs_no_zone_or_dns(monkeypatch):
    fake = _FakeCF()
    code, results = _run_preflight(monkeypatch, fake)
    assert code == 0, [r for r in results if r[0] != preflight.OK]
    assert preflight.HOST == "menapoly-cue-cloud.pmenapoly.workers.dev"
    assert not any("/zones" in c for c in fake.calls)  # menapoly-digital.com is never read or changed
    assert any(r[1] == "DNS" and "no change" in r[2] for r in results)


def test_preflight_workers_dev_fails_closed_without_access_or_subdomain(monkeypatch):
    code, results = _run_preflight(monkeypatch, _FakeCF(apps=False))
    assert code == 1 and any("Access application" in r[1] and r[0] == preflight.BAD for r in results)
    code, results = _run_preflight(monkeypatch, _FakeCF(subdomain=""))
    assert code == 1 and any(r[1] == "workers.dev subdomain" and r[0] == preflight.BAD for r in results)


def test_after_deploy_probe_requires_access_in_front_of_the_api():
    """A Worker-side 401 on a people path means Access isn't covering it: the probe must fail (and the deploy is then
    removed). Only Access's own sign-in redirect passes for the app, API and upload paths."""
    login = "https://menapoly.cloudflareaccess.com/cdn-cgi/access/login/x"
    assert preflight.probe_result("GET", 302, login, True)[0] == preflight.OK
    assert preflight.probe_result("GET", 401, "", True)[0] == preflight.BAD          # reached the Worker
    assert preflight.probe_result("GET", 200, "", True)[0] == preflight.BAD          # public
    assert preflight.probe_result("GET", 302, "https://evil.example/", True)[0] == preflight.BAD
    assert preflight.probe_result("POST", 403, "", False)[0] == preflight.OK          # Access refusing a POST
    assert preflight.probe_result("POST", 201, "", False)[0] == preflight.BAD
    paths = [p for _, p, _ in preflight.PROBES]
    assert "/" in paths and any(p.endswith("/uploads") for p in paths) and "/v1/projects" in paths


def test_after_deploy_probe_fails_when_only_the_worker_protects_the_api(monkeypatch):
    """Simulates Access covering only the web page: API paths answer 401 from the Worker → probe fails closed."""
    class Resp:
        def __init__(self, code, loc=""): self.status_code, self.headers = code, {"location": loc}

    class Client:
        def request(self, method, url, json=None):
            if url.endswith("/") or url.endswith(".html"):
                return Resp(302, "https://menapoly.cloudflareaccess.com/cdn-cgi/access/login")
            return Resp(401)

    preflight.results.clear()
    monkeypatch.setattr(preflight, "wrangler", lambda *a: (0, "x"))
    preflight.probe(Client())
    assert any(r[0] == preflight.BAD and "/v1/projects" in r[1] for r in preflight.results)
    preflight.results.clear()


def test_people_app_must_allow_only_the_owner_emails_explicitly():
    owner = ["owner@example.test"]
    allow = lambda *rules: [{"id": "p", "name": "Owner", "decision": "allow", "include": list(rules)}]  # noqa: E731
    assert preflight.people_policy_problems(allow({"email": {"email": "Owner@Example.test"}}), owner) == []
    assert preflight.people_policy_problems(allow({"email": {"email": "someone@else.test"}}), owner)
    assert preflight.people_policy_problems(allow({"email_domain": {"domain": "gmail.com"}}), owner)
    assert preflight.people_policy_problems(allow({"group": {"id": "g"}}), owner)
    assert preflight.people_policy_problems([], owner)  # nothing visible → can't verify → blocked
    assert preflight.people_policy_problems([{"name": "b", "decision": "bypass", "include": [{"everyone": {}}]}], owner)


def test_reusable_policies_listed_on_the_app_are_checked_too(monkeypatch):
    monkeypatch.setattr(preflight, "cf", lambda client, path, **k: [])
    app = {"id": "a1", "policies": [{"id": "r1", "name": "Everyone", "decision": "allow", "include": [{"everyone": {}}]}]}
    pols = preflight.app_policies(None, "acc", app)
    assert pols and preflight.people_policy_problems(pols, ["owner@example.test"])


def test_preflight_blocks_deploy_when_access_allows_a_whole_domain(monkeypatch):
    fake = _FakeCF()
    original = fake.__call__

    def domain_wide(client, path, **params):
        if path.endswith("/a1/policies"):
            return [{"name": "Gmail", "decision": "allow", "include": [{"email_domain": {"domain": "gmail.com"}}]}]
        return original(client, path, **params)

    code, results = _run_preflight(monkeypatch, domain_wide)
    assert code == 1 and any("email_domain" in r[2] for r in results)


def test_confirmed_address_and_growth_loop_untouched(monkeypatch):
    """The owner confirmed the subdomain: the pilot address is fixed, another subdomain stops the run, and the only
    Worker the pilot ever deploys or deletes is menapoly-cue-cloud (never prissly-growth-loop-staging)."""
    assert preflight.workers_dev_host(preflight.EXPECTED_WORKERS_SUBDOMAIN) == "menapoly-cue-cloud.pmenapoly.workers.dev"
    code, results = _run_preflight(monkeypatch, _FakeCF(subdomain="someoneelse"))
    assert code == 1 and any("not the confirmed" in r[2] for r in results)
    src = (CP / "pilot" / "ci.py").read_text()
    assert ci.WORKER == "menapoly-cue-cloud" and "growth" not in src.lower()
    assert all('WORKER' in line for line in src.splitlines() if '"delete"' in line)
    assert '"name": "menapoly-cue-cloud"' in (CP / "wrangler.jsonc").read_text()
