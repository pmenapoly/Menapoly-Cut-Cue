#!/usr/bin/env python3
"""GitHub Actions steps for the Menapoly Cue pilot. Called only by .github/workflows/pilot.yml after its gate job
(branch + typed phrase) and the protected `menapoly-cue-pilot` environment (owner approval + secrets) have passed.

    python cloud/control-plane/pilot/ci.py provision   # D1, private R2 (+ CORS, lifecycle, no public URL), queues, schema
    python cloud/control-plane/pilot/ci.py deploy      # gate → deploy with secrets in one step → probe → auto-remove on failure
    python cloud/control-plane/pilot/ci.py rollback    # remove the pilot Worker (and with it its address)

PILOT_TARGET picks the address: workers-dev (https://menapoly-cue-cloud.<subdomain>.workers.dev, no DNS change; what
the workflow uses) or custom-domain (https://cue.menapoly-digital.com, needs the zone active on Cloudflare).

Secrets are read from the environment, written only to a mode-600 file in RUNNER_TEMP for the deploy, and deleted
afterwards. Nothing secret is printed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

import preflight

HERE = Path(__file__).resolve().parent
CP = HERE.parent
WORKER, D1, BUCKET = "menapoly-cue-cloud", "menapoly-cue-cloud", "menapoly-cue-media"
QUEUES = ["menapoly-cue-events", "menapoly-cue-events-dlq"]
DEPLOY_SECRETS = ["CF_ACCESS_AUD", "CF_ACCESS_TEAM_DOMAIN", "OWNER_EMAILS", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]


def wrangler(*args: str, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    print("+ wrangler " + " ".join(args), flush=True)
    r = subprocess.run([shutil.which("npx") or "npx", "wrangler", *args], cwd=CP, text=True,
                       capture_output=capture, timeout=600)
    if check and r.returncode != 0:
        if capture:
            print(r.stdout[-2000:], r.stderr[-2000:], sep="\n")
        raise SystemExit(f"wrangler {' '.join(args[:3])} failed (exit {r.returncode})")
    return r


def run_preflight(stage: str) -> None:
    r = subprocess.run([sys.executable, str(HERE / "preflight.py"), "--ci", "--stage", stage], timeout=600)
    if r.returncode != 0:
        raise SystemExit(f"Preflight ({stage}) failed: nothing was changed by this step.")


def target() -> tuple[str, str]:
    """(mode, hostname) for this run. Fails closed if the target is missing or its address can't be determined."""
    mode = preflight.target_mode(ci=True)
    if not mode:
        raise SystemExit(f"PILOT_TARGET must be one of {', '.join(preflight.TARGETS)}. Nothing was changed.")
    if mode == "custom-domain":
        return mode, preflight.CUSTOM_HOST
    client = httpx.Client(headers={"authorization": f"Bearer {os.environ.get('CLOUDFLARE_API_TOKEN', '')}"}, timeout=30)
    sub = preflight.workers_subdomain(client, os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""))
    if not sub:
        raise SystemExit("The account has no workers.dev subdomain yet (Workers & Pages → Account details). Nothing was changed.")
    return mode, preflight.workers_dev_host(sub)


def config_text(database_id: str, mode: str) -> str:
    """wrangler.jsonc with the D1 database_id filled in (the committed file stays id-free). For workers-dev the
    custom-domain route is dropped and workers.dev is switched on; preview URLs stay off in both."""
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", database_id or ""):
        raise SystemExit("D1_DATABASE_ID secret is missing or not a D1 id. Run the provision step and save the id it prints.")
    text = (CP / "wrangler.jsonc").read_text()
    new, n = re.subn(r'("database_name":\s*"menapoly-cue-cloud",)', rf'\1 "database_id": "{database_id}",', text)
    if n != 1:
        raise SystemExit("Could not place database_id in wrangler.jsonc")
    if mode == "workers-dev":
        new, a = re.subn(r'"workers_dev":\s*false,', '"workers_dev": true,', new)
        new, b = re.subn(r'\n\s*"routes":\s*\[[^\]]*\],[^\n]*', "", new)
        if a != 1 or b != 1 or not re.search(r'"preview_urls":\s*false,', new):
            raise SystemExit("Could not switch wrangler.jsonc to the workers.dev address safely")
    return new


def ci_config(database_id: str, mode: str = "custom-domain") -> Path:
    out = CP / "wrangler.ci.jsonc"
    out.write_text(config_text(database_id, mode))
    return out


def cors_file(host: str) -> Path:
    """R2 CORS allowing uploads and downloads only from the pilot's own address."""
    rules = json.loads((HERE / "r2-cors.json").read_text())
    rules["rules"][0]["allowed"]["origins"] = [f"https://{host}"]
    out = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "cue-r2-cors.json"
    out.write_text(json.dumps(rules))
    return out


def provision() -> None:
    run_preflight("before-provision")
    mode, host = target()
    d1 = wrangler("d1", "list", "--json", capture=True)
    existing = {d.get("name"): d.get("uuid") for d in json.loads(d1.stdout[d1.stdout.index("["):])}
    if D1 in existing:
        db_id = existing[D1]
        print(f"D1 {D1} already exists.")
    else:
        out = wrangler("d1", "create", D1, capture=True).stdout
        m = re.search(r'"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"', out)
        if not m:
            raise SystemExit("D1 was created but its id could not be read; see the Cloudflare dashboard → D1.")
        db_id = m.group(1)
    buckets = wrangler("r2", "bucket", "list", capture=True).stdout
    if not re.search(rf"name:\s+{BUCKET}\b", buckets):
        wrangler("r2", "bucket", "create", BUCKET)
    wrangler("r2", "bucket", "dev-url", "disable", BUCKET, "--force")
    wrangler("r2", "bucket", "cors", "set", BUCKET, "--file", str(cors_file(host)), "--force")
    wrangler("r2", "bucket", "lifecycle", "add", BUCKET, "abort-incomplete-uploads", "--abort-multipart-days", "2", "--force", check=False)
    queues = wrangler("queues", "list", capture=True).stdout
    for q in QUEUES:
        if q not in queues:
            # 24 h retention: the most Workers Free allows (its default of 4 days is refused there); also fine on Paid.
            wrangler("queues", "create", q, "--message-retention-period-secs", "86400")
    cfg = ci_config(db_id, mode)
    wrangler("d1", "migrations", "apply", "DB", "--remote", "--config", cfg.name)
    cfg.unlink()
    print("\nProvisioned. Save this as the environment secret D1_DATABASE_ID (it is an id, not a password):")
    print(f"  {db_id}")


def deploy() -> None:
    missing = [k for k in DEPLOY_SECRETS + ["D1_DATABASE_ID"] if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"Missing environment secrets: {', '.join(missing)}. Nothing was deployed.")
    run_preflight("before-deploy")
    mode, host = target()
    cfg = ci_config(os.environ["D1_DATABASE_ID"], mode)
    secrets = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "cue-secrets.json"
    try:
        fd = os.open(secrets, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump({k: os.environ[k] for k in DEPLOY_SECRETS}, fh)
        wrangler("d1", "migrations", "apply", "DB", "--remote", "--config", cfg.name)
        # One step: the first version already carries the Access settings, so it never runs without sign-in.
        wrangler("deploy", "--config", cfg.name, "--secrets-file", str(secrets))
    finally:
        secrets.unlink(missing_ok=True)
        cfg.unlink(missing_ok=True)
    r = subprocess.run([sys.executable, str(HERE / "preflight.py"), "--ci", "--stage", "after-deploy"], timeout=600)
    if r.returncode != 0:
        print("::error::After-deploy check failed. Removing the pilot Worker now (fail closed).", flush=True)
        wrangler("delete", WORKER, "--force", check=False)
        raise SystemExit(1)
    print(f"Deployed and verified at https://{host}: every probe without sign-in was redirected to Cloudflare Access or refused.")


def rollback() -> None:
    wrangler("delete", WORKER, "--force")
    print("The pilot Worker and its route are removed. D1 and R2 data are kept until you delete them in the dashboard.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"provision": provision, "deploy": deploy, "rollback": rollback}.get(cmd, lambda: sys.exit("usage: ci.py provision|deploy|rollback"))()
