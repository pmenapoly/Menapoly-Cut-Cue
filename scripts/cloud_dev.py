#!/usr/bin/env python3
"""Run the hybrid cloud stack locally: the control-plane Worker (wrangler dev, local D1/Queues/cron) with moto standing
in for private R2. Nothing reaches Cloudflare. Used by `make cloud-dev` and the mobile browser tests.

    python scripts/cloud_dev.py [--port 8790] [--state-file out.json] [--fixture-dir DIR]

Writes a JSON state file (url, a freshly registered worker token, the environment for `python -m cutcue.agent`)
and runs until interrupted. The worker token is printed only into that local file, never to the terminal.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cloud_stack as cs  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--state-file", default=str(ROOT / "data" / "cloud-dev.json"))
    parser.add_argument("--fixture-dir", default="", help="generate/use synthesized fixture media for the agent (tests)")
    args = parser.parse_args()
    problem = cs.available()
    if problem:
        sys.exit(problem)
    work = Path(tempfile.mkdtemp(prefix="cue-cloud-dev-"))
    moto = cs.Moto(work, new_session=False)
    cp = cs.ControlPlane(work, moto.url, port=args.port, new_session=False)
    worker = cp.api("POST", "/v1/workers", json={"name": "Local Mac"}).json()
    agent_env = {"CUE_CLOUD_URL": cp.url, "CUE_WORKER_TOKEN": worker["token"], "CUE_AGENT_DATA_DIR": str(work / "agent"),
                 "CUE_AGENT_POLL_SECONDS": "1", "CUE_AGENT_MIN_FREE_MEM_GB": "0.2", "CUE_AGENT_MIN_FREE_DISK_GB": "0.5"}
    if args.fixture_dir:
        import make_fixture

        fixture = Path(args.fixture_dir)
        if not (fixture / "market-mocha-interview.mp4").exists():
            fixture.mkdir(parents=True, exist_ok=True)
            make_fixture.main(fixture)
        agent_env.update({"CUTCUE_TRANSCRIBER": "fixture", "CUTCUE_FIXTURE_DIR": str(fixture.resolve())})
    state = {"url": cp.url, "worker_id": worker["id"], "agent_env": agent_env, "d1": str(cp.db_path()), "work": str(work),
             "python": sys.executable, "backend": str(ROOT / "backend")}
    Path(args.state_file).parent.mkdir(parents=True, exist_ok=True)
    Path(args.state_file).write_text(json.dumps(state, indent=1))
    os.chmod(args.state_file, 0o600)
    print(f"Menapoly Cue cloud (local) ready at {cp.url}  (state: {args.state_file})", flush=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: stop.set())
    parent = os.getppid()
    try:
        # Also stop if whoever started us goes away (e.g. a test runner killed with SIGKILL).
        while not stop.wait(1) and os.getppid() == parent:
            pass
    finally:
        cp.stop()
        moto.stop()
        shutil.rmtree(work, ignore_errors=True)
        Path(args.state_file).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
