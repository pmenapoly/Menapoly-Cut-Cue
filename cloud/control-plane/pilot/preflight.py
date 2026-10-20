#!/usr/bin/env python3
"""Read-only preflight for the Menapoly Cue private pilot (cue.menapoly-digital.com).

Changes nothing. It reads your Cloudflare account and reports what is ready, what is not done yet, and anything that
would make the pilot unsafe. Run it before provisioning, again before deploying, and after deploying.

    export CLOUDFLARE_ACCOUNT_ID=…            # Dashboard → Workers & Pages → Account ID
    export CLOUDFLARE_API_TOKEN=…             # a READ-ONLY token (see docs/cloud/pilot/deployment-plan.md)
    backend/.venv/bin/python cloud/control-plane/pilot/preflight.py [--stage before-provision|before-deploy|after-deploy]

Values of secrets are never printed. Exit code 1 if anything is unsafe or a required item for the stage is missing.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

ZONE, HOST = "menapoly-digital.com", "cue.menapoly-digital.com"
WORKER, D1, BUCKET, QUEUES = "menapoly-cue-cloud", "menapoly-cue-cloud", "menapoly-cue-media", ["menapoly-cue-events", "menapoly-cue-events-dlq"]
RELAY = "pmenapoly/menapolyrelay"
RELAY_DEPLOY_WORKFLOWS = ["Deploy Menapoly Cue to Cloudflare", "Deploy Preview (menapoly-cue-preview)"]
HERE = Path(__file__).resolve().parent
API = "https://api.cloudflare.com/client/v4"

OK, TODO, BAD, INFO = "OK", "NOT YET", "PROBLEM", "INFO"
results: list[tuple[str, str, str]] = []


def report(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))
    print(f"[{status:>8}] {check}" + (f": {detail}" if detail else ""))


def cf(client: httpx.Client, path: str, **params):
    r = client.get(API + path, params=params)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not data.get("success", False):
        errors = "; ".join(e.get("message", "") for e in data.get("errors", [])) or r.text[:200]
        raise RuntimeError(f"{path}: HTTP {r.status_code} {errors}")
    return data["result"]


def wrangler(*args: str) -> tuple[int, str]:
    npx = shutil.which("npx")
    if not npx:
        return 127, "npx not found"
    r = subprocess.run([npx, "wrangler", *args], cwd=HERE.parent, capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stdout + r.stderr)


def policy_problems(policies: list[dict], allow_service_token: bool) -> list[str]:
    """Anything that would let someone in without a listed email (or the Mac's service token)."""
    out = []
    for p in policies:
        decision = p.get("decision")
        rules = [list(rule.keys())[0] for rule in p.get("include", []) if rule]
        if decision == "bypass":
            out.append(f"policy '{p.get('name')}' is BYPASS (public)")
        if decision == "allow" and "everyone" in rules:
            out.append(f"policy '{p.get('name')}' allows EVERYONE")
        if decision == "non_identity" and not allow_service_token:
            out.append(f"policy '{p.get('name')}' is Service Auth on the people app")
        if decision == "allow" and any(r not in ("email", "email_domain", "email_list", "group", "login_method") for r in rules):
            out.append(f"policy '{p.get('name')}' has unexpected include rules {rules}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["before-provision", "before-deploy", "after-deploy"], default="before-provision")
    ap.add_argument("--ci", action="store_true", help="GitHub Actions: fail closed on anything missing, check Relay via the GitHub API")
    args = ap.parse_args()
    global CI, STAGE
    CI, STAGE = args.ci, args.stage
    account, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""), os.environ.get("CLOUDFLARE_API_TOKEN", "")
    print(f"Menapoly Cue pilot preflight ({args.stage}), read-only\n")

    # --- 0. Security gate: Relay's deploy workflows must be disabled ---------------------------------------------
    gh = None if args.ci else shutil.which("gh")
    if args.ci:
        relay_token = os.environ.get("RELAY_ACTIONS_TOKEN", "")
        if not relay_token:
            report(BAD, "Security gate: Relay workflows", "RELAY_ACTIONS_TOKEN secret missing (read-only Actions token for MenapolyRelay)")
        else:
            try:
                r = httpx.get(f"https://api.github.com/repos/{RELAY}/actions/workflows", timeout=30,
                              headers={"authorization": f"Bearer {relay_token}", "accept": "application/vnd.github+json"})
                r.raise_for_status()
                states = {w["name"]: w["state"] for w in r.json().get("workflows", [])}
                for name in RELAY_DEPLOY_WORKFLOWS:
                    state = states.get(name, "missing")
                    report(OK if state.startswith("disabled") or state == "missing" else BAD, f"Security gate: Relay workflow '{name}'", state)
            except httpx.HTTPError as exc:
                report(BAD, "Security gate: Relay workflows", f"could not read them ({exc.__class__.__name__})")
    elif gh:
        r = subprocess.run([gh, "workflow", "list", "--all", "-R", RELAY, "--json", "name,state"], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            states = {w["name"]: w["state"] for w in json.loads(r.stdout)}
            for name in RELAY_DEPLOY_WORKFLOWS:
                state = states.get(name, "missing")
                report(OK if state != "active" else BAD, f"Security gate: Relay workflow '{name}'", state)
        else:
            report(TODO, "Security gate: Relay workflows", "gh could not read them (gh auth login)")
    else:
        report(TODO, "Security gate: Relay workflows", "install GitHub CLI (brew install gh) or check Actions in the browser")

    if not account or not token:
        report(BAD, "Cloudflare credentials", "set CLOUDFLARE_ACCOUNT_ID and a read-only CLOUDFLARE_API_TOKEN")
        return summary()
    client = httpx.Client(headers={"authorization": f"Bearer {token}"}, timeout=30)

    # --- 1. Token -----------------------------------------------------------------------------------------------
    try:
        try:
            verify = cf(client, "/user/tokens/verify")
        except RuntimeError:
            verify = cf(client, f"/accounts/{account}/tokens/verify")
        report(OK if verify.get("status") == "active" else BAD, "API token is active", verify.get("status", "?"))
    except RuntimeError as exc:
        report(BAD, "API token", str(exc))
        return summary()

    # --- 2. Domain ownership and DNS access ----------------------------------------------------------------------
    try:
        zones = cf(client, "/zones", name=ZONE)
        if not zones:
            report(BAD, f"Zone {ZONE} in this Cloudflare account", "not found: add the domain to Cloudflare (or use the account that has it)")
        else:
            z = zones[0]
            same = z.get("account", {}).get("id") == account
            report(OK if same else BAD, f"Zone {ZONE} belongs to this account", "yes" if same else "a different account owns it")
            report(OK if z.get("status") == "active" else BAD, "Zone is active (nameservers point to Cloudflare)",
                   f"{z.get('status')}; nameservers {', '.join(z.get('name_servers', []))}")
            records = cf(client, f"/zones/{z['id']}/dns_records", name=HOST)
            if not records:
                report(OK if args.stage != "after-deploy" else TODO, f"No existing DNS record for {HOST}",
                       "free for the Worker custom domain" if args.stage != "after-deploy" else "expected the Worker's record")
            else:
                kinds = ", ".join(f"{r['type']}→{r.get('content', '')}" for r in records)
                # A record is expected after the first deploy; before one, it would clash with the Worker's custom domain.
                code, _ = wrangler("deployments", "list", "--name", WORKER) if args.stage == "before-deploy" else (1, "")
                redeploy = args.stage == "before-deploy" and code == 0
                report(OK if args.stage == "after-deploy" or redeploy else BAD, f"DNS record for {HOST}",
                       kinds + (" (the pilot Worker's own custom domain: re-deploy)" if redeploy else ""))
    except RuntimeError as exc:
        report(BAD, "Zone/DNS read", f"{exc} (token needs Zone:Read and DNS:Read)")

    # --- 3. Cloudflare Access ----------------------------------------------------------------------------------
    try:
        org = cf(client, f"/accounts/{account}/access/organizations")
        team = org.get("auth_domain") if isinstance(org, dict) else None
        report(OK if team else TODO, "Zero Trust team domain (CF_ACCESS_TEAM_DOMAIN)", team or "Zero Trust not set up yet")
        if args.ci:
            want_team = os.environ.get("CF_ACCESS_TEAM_DOMAIN", "").replace("https://", "").strip("/").lower()
            report(OK if team and want_team == team.lower() else BAD, "CF_ACCESS_TEAM_DOMAIN secret matches the team domain",
                   "yes" if team and want_team == team.lower() else "missing or different")
        apps = cf(client, f"/accounts/{account}/access/apps")
        people = [a for a in apps if a.get("domain", "").rstrip("/") == HOST]
        workers = [a for a in apps if a.get("domain", "").rstrip("/") == f"{HOST}/v1/worker"]
        need = args.stage != "before-provision"
        if not people:
            report(BAD if need else TODO, f"Access application for {HOST}", "missing; create it BEFORE deploying")
        for a in people:
            pols = cf(client, f"/accounts/{account}/access/apps/{a['id']}/policies")
            probs = policy_problems(pols, allow_service_token=False)
            report(BAD if probs else OK, f"Access app '{a.get('name')}' ({HOST})",
                   "; ".join(probs) or f"{len(pols)} allow-by-email policy(ies); AUD tag ends …{str(a.get('aud', ''))[-6:]}")
            if args.ci:
                same = bool(a.get("aud")) and a.get("aud") == os.environ.get("CF_ACCESS_AUD", "")
                report(OK if same else BAD, "CF_ACCESS_AUD secret matches this Access app", "yes" if same else "missing or different")
            if a.get("session_duration"):
                report(INFO, "Access session duration", a["session_duration"])
        if not workers:
            report(BAD if need else TODO, f"Access application for {HOST}/v1/worker (Service Auth for the Mac)", "missing")
        for a in workers:
            pols = cf(client, f"/accounts/{account}/access/apps/{a['id']}/policies")
            probs = policy_problems(pols, allow_service_token=True)
            only_service = all(p.get("decision") == "non_identity" for p in pols) and pols
            report(BAD if probs or not only_service else OK, f"Access app '{a.get('name')}' (Mac worker path)",
                   "; ".join(probs) or ("Service Auth only" if only_service else "should contain only a Service Auth policy"))
        public = [a.get("domain") for a in apps if HOST in a.get("domain", "") and a.get("type") not in ("self_hosted", None)]
        if public:
            report(INFO, "Other Access apps on this host", ", ".join(public))
    except RuntimeError as exc:
        report(BAD, "Access read", f"{exc} (token needs Access: Apps and Policies Read, Access: Organizations Read)")

    # --- 4. Pilot resources (names must not exist before provisioning; must exist after) ------------------------
    want = args.stage != "before-provision"
    code, out = wrangler("d1", "list", "--json")
    if code == 0:
        names = {d.get("name"): d.get("uuid") for d in json.loads(out[out.index("["):])}
        report(OK if (D1 in names) == want else (TODO if want else BAD), f"D1 database {D1}",
               "exists" if D1 in names else "not created")
        if "menapoly-cue-production" in names:
            report(INFO, "Relay's D1 database exists separately", "menapoly-cue-production (left untouched)")
        cfg = (HERE.parent / "wrangler.jsonc").read_text()
        has_id = bool(re.search(r'"database_id"\s*:\s*"[0-9a-f-]{36}"', cfg))
        if want:
            report(OK if has_id and names.get(D1, "") in cfg else BAD, "wrangler.jsonc database_id matches the D1 database",
                   "yes" if has_id else "add the database_id printed by `wrangler d1 create`")
    else:
        report(BAD if args.ci else TODO, "D1 list", "wrangler can't read D1 (token permission D1:Read/Edit missing?)" if args.ci
               else "wrangler not signed in (npx wrangler login) or no access")
    code, out = wrangler("r2", "bucket", "list")
    if code == 0:
        exists = re.search(rf"name:\s+{BUCKET}\b", out) is not None
        report(OK if exists == want else (TODO if want else BAD), f"R2 bucket {BUCKET}", "exists" if exists else "not created")
        if exists:
            _, dev = wrangler("r2", "bucket", "dev-url", "get", BUCKET)
            public = "enabled" in dev.lower() and "disabled" not in dev.lower()
            report(BAD if public else OK, "R2 public r2.dev URL", "ENABLED (must be off)" if public else "off")
            _, dom = wrangler("r2", "bucket", "domain", "list", BUCKET)
            has_domain = "domain:" in dom.lower()
            report(BAD if has_domain else OK, "R2 public custom domain", "CONNECTED (must be none)" if has_domain else "none")
    code, out = wrangler("queues", "list")
    if code == 0:
        for q in QUEUES:
            exists = q in out
            report(OK if exists == want else (TODO if want else BAD), f"Queue {q}", "exists" if exists else "not created")

    # --- 5. After deploy: nothing answers without Access --------------------------------------------------------
    if args.stage == "after-deploy":
        bare = httpx.Client(timeout=20, follow_redirects=False)
        for path in ("/", "/v1/health", "/v1/projects", "/v1/worker/lease", "/review.html", "/v1/public/review/rv_" + "A" * 43):
            try:
                r = bare.get(f"https://{HOST}{path}")
                login = r.status_code in (302, 303) and "cloudflareaccess.com" in r.headers.get("location", "")
                refused = r.status_code in (401, 403)
                report(OK if login or refused else BAD, f"Unauthenticated GET {path}",
                       f"{r.status_code} → {'Access sign-in' if login else 'refused' if refused else 'REACHABLE'}")
            except httpx.HTTPError as exc:
                report(BAD, f"Unauthenticated GET {path}", str(exc))
        code, out = wrangler("deployments", "list", "--name", WORKER)
        report(INFO if code == 0 else TODO, "Worker deployments", out.strip().splitlines()[-1] if code == 0 and out.strip() else "none")
    return summary()


CI = False
STAGE = "before-provision"


def summary() -> int:
    bad = [r for r in results if r[0] == BAD]
    todo = [r for r in results if r[0] == TODO]
    print(f"\n{len(results) - len(bad) - len(todo)} ok/info, {len(todo)} not yet, {len(bad)} problem(s)")
    if CI and STAGE != "before-provision" and todo:
        print("CI: items that are not set up yet block this step (fail closed).")
        return 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
