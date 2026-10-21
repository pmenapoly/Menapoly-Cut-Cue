#!/usr/bin/env python3
"""Read-only preflight for the Menapoly Cue private pilot.

Two deploy targets (PILOT_TARGET):
  workers-dev    https://menapoly-cue-cloud.<your-subdomain>.workers.dev behind Cloudflare Access. No DNS changes:
                 menapoly-digital.com stays on Canva's nameservers (the GitHub workflow uses this target).
  custom-domain  https://cue.menapoly-digital.com. Needs the zone active on Cloudflare (nameservers moved), which
                 would stop the Canva website, so it is kept for later.

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

ZONE, CUSTOM_HOST = "menapoly-digital.com", "cue.menapoly-digital.com"
HOST = CUSTOM_HOST  # the address being checked; main() switches it to the workers.dev hostname for that target
TARGETS = ("workers-dev", "custom-domain")
# Confirmed by the owner on 2026-10-21 (Workers & Pages → Account details). The pilot address is therefore
# https://menapoly-cue-cloud.pmenapoly.workers.dev. Any other subdomain means a different account: stop.
EXPECTED_WORKERS_SUBDOMAIN = "pmenapoly"
# Other Workers in the account (e.g. prissly-growth-loop-staging) are never read, changed or deleted.
WORKER, D1, BUCKET, QUEUES = "menapoly-cue-cloud", "menapoly-cue-cloud", "menapoly-cue-media", ["menapoly-cue-events", "menapoly-cue-events-dlq"]
RELAY = "pmenapoly/menapolyrelay"
RELAY_DEPLOY_WORKFLOWS = ["Deploy Menapoly Cue to Cloudflare", "Deploy Preview (menapoly-cue-preview)"]
HERE = Path(__file__).resolve().parent
API = "https://api.cloudflare.com/client/v4"

OK, TODO, BAD, INFO = "OK", "NOT YET", "PROBLEM", "INFO"
results: list[tuple[str, str, str]] = []


def target_mode(ci: bool) -> str:
    """CI must name its target explicitly (fail closed); local runs default to the custom domain (provision.sh)."""
    mode = os.environ.get("PILOT_TARGET", "" if ci else "custom-domain").strip()
    return mode if mode in TARGETS else ""


def workers_dev_host(subdomain: str) -> str:
    return f"{WORKER}.{subdomain}.workers.dev"


def workers_subdomain(client: httpx.Client, account: str) -> str:
    """The account's workers.dev subdomain (Workers & Pages → Account details), or "" if it was never set up."""
    try:
        return (cf(client, f"/accounts/{account}/workers/subdomain") or {}).get("subdomain") or ""
    except RuntimeError:
        return ""


def app_hosts(app: dict) -> set[str]:
    """Every hostname/path an Access application covers (older apps: domain; newer: self_hosted_domains, destinations)."""
    hosts = {app.get("domain") or ""} | set(app.get("self_hosted_domains") or [])
    hosts |= {d.get("uri", "") for d in app.get("destinations") or [] if isinstance(d, dict)}
    return {h.replace("https://", "").rstrip("/").lower() for h in hosts if h}


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


def app_policies(client: httpx.Client, account: str, app: dict) -> list[dict]:
    """Policies on an Access app: the per-app endpoint plus any listed on the app itself (reusable policies)."""
    pols = list(cf(client, f"/accounts/{account}/access/apps/{app['id']}/policies") or [])
    seen = {p.get("id") for p in pols if p.get("id")}
    pols += [p for p in app.get("policies") or [] if isinstance(p, dict) and p.get("decision") and p.get("id") not in seen]
    return pols


def people_policy_problems(policies: list[dict], allowed: list[str]) -> list[str]:
    """The people app must name the allowed owner emails explicitly. Domain, list, group or login-method rules can't
    be checked against OWNER_EMAILS, and an app with no visible policy can't be verified: both fail closed."""
    out = policy_problems(policies, allow_service_token=False)
    if not any(p.get("decision") == "allow" for p in policies):
        out.append("no Allow policy is visible on the app")
    allowed = {e.strip().lower() for e in allowed if e.strip()}
    for p in policies:
        if p.get("decision") != "allow":
            continue
        for rule in p.get("include", []):
            kind = next(iter(rule), "")
            if kind != "email":
                out.append(f"policy '{p.get('name')}' uses a '{kind}' rule; use explicit email addresses")
            elif allowed and str(rule["email"].get("email", "")).lower() not in allowed:
                out.append(f"policy '{p.get('name')}' allows an email that isn't in OWNER_EMAILS")
    return out


def database_id_check(real_id: str, ci: bool) -> tuple[bool, str, str]:
    """The Worker must be bound to the pilot D1 database. In GitHub Actions the committed wrangler.jsonc stays id-free and
    ci.py fills the id in from the D1_DATABASE_ID secret, so compare the secret; locally, compare the file."""
    if not real_id:
        return False, "D1 database id", "the pilot database doesn't exist"
    if ci:
        same = os.environ.get("D1_DATABASE_ID", "") == real_id
        return same, "D1_DATABASE_ID secret matches the D1 database", "yes" if same else "missing or different: copy the id the provision run printed"
    cfg = (HERE.parent / "wrangler.jsonc").read_text()
    m = re.search(r'"database_id"\s*:\s*"([0-9a-f-]{36})"', cfg)
    same = bool(m) and m.group(1) == real_id
    return same, "wrangler.jsonc database_id matches the D1 database", "yes" if same else "add the database_id printed by `wrangler d1 create`"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["before-provision", "before-deploy", "after-deploy"], default="before-provision")
    ap.add_argument("--ci", action="store_true", help="GitHub Actions: fail closed on anything missing, check Relay via the GitHub API")
    args = ap.parse_args()
    global CI, STAGE, HOST
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

    # --- 2. Address: workers.dev (no DNS change) or the custom domain (zone must be active) ---------------------
    mode = target_mode(args.ci)
    if not mode:
        report(BAD, "Deploy target (PILOT_TARGET)", f"missing or not one of {', '.join(TARGETS)}")
        return summary()
    report(INFO, "Deploy target", mode)
    if mode == "workers-dev":
        sub = workers_subdomain(client, account)
        if sub and sub != EXPECTED_WORKERS_SUBDOMAIN:
            report(BAD, "workers.dev subdomain", f"'{sub}' is not the confirmed '{EXPECTED_WORKERS_SUBDOMAIN}' (wrong account?)")
            return summary()
        if sub:
            HOST = workers_dev_host(sub)
            report(OK, "workers.dev address", f"https://{HOST} (Access must cover it before the first deploy)")
        else:
            report(BAD, "workers.dev subdomain", "not set up: Workers & Pages → Account details → workers.dev subdomain "
                                                   "(or the token lacks Workers Scripts Read)")
            return summary()
        report(INFO, "DNS", f"no change: {ZONE} stays on its current nameservers; no {CUSTOM_HOST} record is created")
    else:
        HOST = CUSTOM_HOST
        domain_checks(client, account, args.stage)

    access_checks(client, account, args)
    resource_checks(args)
    if args.stage == "after-deploy":
        probe()
    return summary()


def domain_checks(client: httpx.Client, account: str, stage: str) -> None:
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
                report(OK if stage != "after-deploy" else TODO, f"No existing DNS record for {HOST}",
                       "free for the Worker custom domain" if stage != "after-deploy" else "expected the Worker's record")
            else:
                kinds = ", ".join(f"{r['type']}→{r.get('content', '')}" for r in records)
                # A record is expected after the first deploy; before one, it would clash with the Worker's custom domain.
                code, _ = wrangler("deployments", "list", "--name", WORKER) if stage == "before-deploy" else (1, "")
                redeploy = stage == "before-deploy" and code == 0
                report(OK if stage == "after-deploy" or redeploy else BAD, f"DNS record for {HOST}",
                       kinds + (" (the pilot Worker's own custom domain: re-deploy)" if redeploy else ""))
    except RuntimeError as exc:
        report(BAD, "Zone/DNS read", f"{exc} (token needs Zone:Read and DNS:Read)")


def access_checks(client: httpx.Client, account: str, args: argparse.Namespace) -> None:
    # --- 3. Cloudflare Access ----------------------------------------------------------------------------------
    try:
        org = cf(client, f"/accounts/{account}/access/organizations")
        team = org.get("auth_domain") if isinstance(org, dict) else None
        report(OK if team else TODO, "Zero Trust team domain (CF_ACCESS_TEAM_DOMAIN)", team or "Zero Trust not set up yet")
        if args.ci:
            want_team = os.environ.get("CF_ACCESS_TEAM_DOMAIN", "").replace("https://", "").strip("/").lower()
            # Before Zero Trust exists this is "not yet" (later stages still fail closed on it); once it exists the
            # secret must match exactly.
            report(TODO if not team else OK if want_team == team.lower() else BAD, "CF_ACCESS_TEAM_DOMAIN secret matches the team domain",
                   "set up Access first" if not team else "yes" if want_team == team.lower() else "missing or different")
        apps = cf(client, f"/accounts/{account}/access/apps")
        people = [a for a in apps if HOST in app_hosts(a)]
        workers = [a for a in apps if f"{HOST}/v1/worker" in app_hosts(a)]
        need = args.stage != "before-provision"
        if not people:
            report(BAD if need else TODO, f"Access application for {HOST}", "missing; create it BEFORE deploying")
        for a in people:
            pols = app_policies(client, account, a)
            owners = os.environ.get("OWNER_EMAILS", "").split(",") if args.ci else []
            probs = people_policy_problems(pols, owners)
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
            pols = app_policies(client, account, a)
            probs = policy_problems(pols, allow_service_token=True)
            only_service = all(p.get("decision") == "non_identity" for p in pols) and pols
            report(BAD if probs or not only_service else OK, f"Access app '{a.get('name')}' (Mac worker path)",
                   "; ".join(probs) or ("Service Auth only" if only_service else "should contain only a Service Auth policy"))
        public = [a.get("domain") for a in apps if any(HOST in h for h in app_hosts(a)) and a.get("type") not in ("self_hosted", None)]
        if public:
            report(INFO, "Other Access apps on this host", ", ".join(public))
    except RuntimeError as exc:
        report(BAD, "Access read", f"{exc} (token needs Access: Apps and Policies Read, Access: Organizations Read)")


def resource_checks(args: argparse.Namespace) -> None:
    # --- 4. Pilot resources (names must not exist before provisioning; must exist after) ------------------------
    want = args.stage != "before-provision"
    code, out = wrangler("d1", "list", "--json")
    if code == 0:
        names = {d.get("name"): d.get("uuid") for d in json.loads(out[out.index("["):])}
        report(resource(D1 in names, want), f"D1 database {D1}", "exists" if D1 in names else "not created")
        if "menapoly-cue-production" in names:
            report(INFO, "Relay's D1 database exists separately", "menapoly-cue-production (left untouched)")
        if want:
            ok, what, detail = database_id_check(names.get(D1, ""), args.ci)
            report(OK if ok else BAD, what, detail)
    else:
        report(BAD if args.ci else TODO, "D1 list", "wrangler can't read D1 (token permission D1:Read/Edit missing?)" if args.ci
               else "wrangler not signed in (npx wrangler login) or no access")
    code, out = wrangler("r2", "bucket", "list")
    if code == 0:
        exists = re.search(rf"name:\s+{BUCKET}\b", out) is not None
        report(resource(exists, want), f"R2 bucket {BUCKET}", "exists" if exists else "not created")
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
            report(resource(exists, want), f"Queue {q}", "exists (reused)" if exists and not want else "exists" if exists else "not created")


PROBES = [  # (method, path, Access must redirect to sign-in?) — every people path, including API and uploads
    ("GET", "/", True), ("GET", "/review.html", True), ("GET", "/v1/health", True), ("GET", "/v1/projects", True),
    ("GET", "/v1/library", True), ("GET", "/v1/public/review/rv_" + "A" * 43, True),
    ("POST", "/v1/projects/prj_0123456789abcdef/uploads", False), ("POST", "/v1/worker/lease", False),
]


def probe_result(method: str, status: int, location: str, must_redirect: bool) -> tuple[str, str]:
    """Access in front: a GET without sign-in is redirected to <team>.cloudflareaccess.com. A Worker-side 401 alone
    means Access is NOT covering that path (the Worker's own check is only the second lock), so it fails the probe."""
    login = status in (302, 303) and "cloudflareaccess.com" in location
    if login:
        return OK, f"{status} → Access sign-in"
    if not must_redirect and status in (401, 403):
        return OK, f"{status} → refused"
    return BAD, f"{status} → {'reached the Worker, not Access' if status in (401, 403) else 'REACHABLE'}"


def probe(client: httpx.Client | None = None) -> None:
    # --- 5. After deploy: nothing answers without Access --------------------------------------------------------
    bare = client or httpx.Client(timeout=20, follow_redirects=False)
    for method, path, must_redirect in PROBES:
        try:
            r = bare.request(method, f"https://{HOST}{path}", json={} if method == "POST" else None)
            status, detail = probe_result(method, r.status_code, r.headers.get("location", ""), must_redirect)
            report(status, f"Unauthenticated {method} {path}", detail)
        except httpx.HTTPError as exc:
            report(BAD, f"Unauthenticated {method} {path}", str(exc))
    code, out = wrangler("deployments", "list", "--name", WORKER)
    report(INFO if code == 0 else TODO, "Worker deployments", out.strip().splitlines()[-1] if code == 0 and out.strip() else "none")


CI = False
STAGE = "before-provision"


def resource(exists: bool, want: bool) -> str:
    """Before provisioning, a pilot resource that already exists (a provision run that stopped half-way) is reused by
    name, so it's information, not a problem. After provisioning, a missing one is "not yet" (blocks CI)."""
    return OK if exists == want else TODO if want else INFO


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
