#!/usr/bin/env python3
"""GitHub Actions steps for the Menapoly Cue pilot. Called only by .github/workflows/pilot.yml after its gate job
(branch + typed phrase) and the protected `menapoly-cue-pilot` environment (owner approval + secrets) have passed.

    python cloud/control-plane/pilot/ci.py provision   # D1, private R2 (+ CORS, lifecycle, no public URL), queues, schema
    python cloud/control-plane/pilot/ci.py deploy      # gate → deploy with secrets in one step → probe → auto-remove on failure
    python cloud/control-plane/pilot/ci.py rollback    # remove the pilot Worker (and with it the custom-domain route)

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


def preflight(stage: str) -> None:
    r = subprocess.run([sys.executable, str(HERE / "preflight.py"), "--ci", "--stage", stage], timeout=600)
    if r.returncode != 0:
        raise SystemExit(f"Preflight ({stage}) failed: nothing was changed by this step.")


def ci_config(database_id: str) -> Path:
    """wrangler.jsonc with the D1 database_id filled in (the committed file stays id-free)."""
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", database_id or ""):
        raise SystemExit("D1_DATABASE_ID secret is missing or not a D1 id. Run the provision step and save the id it prints.")
    text = (CP / "wrangler.jsonc").read_text()
    new, n = re.subn(r'("database_name":\s*"menapoly-cue-cloud",)', rf'\1 "database_id": "{database_id}",', text)
    if n != 1:
        raise SystemExit("Could not place database_id in wrangler.jsonc")
    out = CP / "wrangler.ci.jsonc"
    out.write_text(new)
    return out


def provision() -> None:
    preflight("before-provision")
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
    wrangler("r2", "bucket", "cors", "set", BUCKET, "--file", "pilot/r2-cors.json", "--force")
    wrangler("r2", "bucket", "lifecycle", "add", BUCKET, "abort-incomplete-uploads", "--abort-multipart-days", "2", "--force", check=False)
    queues = wrangler("queues", "list", capture=True).stdout
    for q in QUEUES:
        if q not in queues:
            # 24 h retention: the most Workers Free allows (its default of 4 days is refused there); also fine on Paid.
            wrangler("queues", "create", q, "--message-retention-period-secs", "86400")
    cfg = ci_config(db_id)
    wrangler("d1", "migrations", "apply", "DB", "--remote", "--config", cfg.name)
    cfg.unlink()
    print("\nProvisioned. Save this as the environment secret D1_DATABASE_ID (it is an id, not a password):")
    print(f"  {db_id}")


def deploy() -> None:
    missing = [k for k in DEPLOY_SECRETS + ["D1_DATABASE_ID"] if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"Missing environment secrets: {', '.join(missing)}. Nothing was deployed.")
    preflight("before-deploy")
    cfg = ci_config(os.environ["D1_DATABASE_ID"])
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
    print("Deployed and verified: every probe without sign-in was redirected to Cloudflare Access or refused.")


def rollback() -> None:
    wrangler("delete", WORKER, "--force")
    print("The pilot Worker and its route are removed. D1 and R2 data are kept until you delete them in the dashboard.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"provision": provision, "deploy": deploy, "rollback": rollback}.get(cmd, lambda: sys.exit("usage: ci.py provision|deploy|rollback"))()
