"""Pilot preflight: the Access policy rules that decide whether the pilot hostname could be reached without sign-in."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cloud" / "control-plane" / "pilot"))
import preflight as p  # noqa: E402


def test_email_allow_policy_is_fine():
    assert p.policy_problems([{"name": "owner", "decision": "allow", "include": [{"email": {"email": "me@example.com"}}]}], False) == []


def test_public_or_overbroad_policies_are_flagged():
    for policy in ({"name": "b", "decision": "bypass", "include": [{"everyone": {}}]},
                   {"name": "e", "decision": "allow", "include": [{"everyone": {}}]},
                   {"name": "ip", "decision": "allow", "include": [{"ip": {"ip": "0.0.0.0/0"}}]}):
        assert p.policy_problems([policy], False), policy


def test_service_auth_only_on_the_worker_app():
    svc = {"name": "mac", "decision": "non_identity", "include": [{"service_token": {"token_id": "t"}}]}
    assert p.policy_problems([svc], allow_service_token=False)
    assert p.policy_problems([svc], allow_service_token=True) == []
