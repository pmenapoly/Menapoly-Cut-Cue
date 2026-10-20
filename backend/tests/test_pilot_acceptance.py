"""The pilot acceptance script, run against the local stack (wrangler dev + moto) with the real agent process."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import cloud_stack as cs

pytestmark = pytest.mark.skipif(cs.available() is not None, reason=cs.available() or "")
ROOT = Path(__file__).resolve().parents[2]


def test_acceptance_script_end_to_end(tmp_path, fixture_dir):
    import pilot_acceptance

    moto = cs.Moto(tmp_path)
    cp = cs.ControlPlane(tmp_path, moto.url)
    agent = None
    try:
        token = cp.api("POST", "/v1/workers", json={"name": "Pilot Mac"}).json()["token"]
        env = {**os.environ, "CUE_CLOUD_URL": cp.url, "CUE_WORKER_TOKEN": token, "CUE_AGENT_DATA_DIR": str(tmp_path / "agent"),
               "CUE_AGENT_POLL_SECONDS": "1", "CUE_AGENT_MIN_FREE_MEM_GB": "0.2", "CUE_AGENT_MIN_FREE_DISK_GB": "0.5",
               "CUTCUE_TRANSCRIBER": "fixture", "CUTCUE_FIXTURE_DIR": str(fixture_dir), "NO_PROXY": "*", "no_proxy": "*"}
        log = (tmp_path / "agent.log").open("w")
        agent = subprocess.Popen([sys.executable, "-m", "cutcue.agent"], cwd=ROOT / "backend", env=env, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.time() + 60
        while not cp.api("GET", "/v1/status").json()["workers_online"]:
            assert time.time() < deadline, "agent never checked in"
            time.sleep(0.5)
        out = tmp_path / "report"
        code = pilot_acceptance.main(["--url", cp.url, "--video", str(fixture_dir / "market-mocha-interview.mp4"),
                                      "--approve", "--out", str(out), "--job-timeout-min", "5"])
        report = json.loads((out / "report.json").read_text())
        statuses = {s["step"]: s["status"] for s in report["steps"]}
        assert code == 0, report
        assert statuses == {"1": "SKIPPED", "2": "VERIFIED", "3": "VERIFIED", "4": "VERIFIED", "5": "VERIFIED", "6": "VERIFIED",
                            "7": "VERIFIED", "8": "VERIFIED", "9": "VERIFIED", "10": "VERIFIED", "11": "SKIPPED"}
        assert (out / "pilot-export.mp4").stat().st_size > 100_000
        assert token not in (out / "report.md").read_text() + (tmp_path / "agent.log").read_text()
    finally:
        if agent:
            agent.terminate()
            agent.wait(30)
        cp.stop()
        moto.stop()


def test_agent_drain_processes_the_queue_then_exits(tmp_path, fixture_dir, settings):
    """--drain-minutes: the mode a temporary (non-Mac) worker would use. Works through the queue and stops."""
    from cutcue.agent import Agent, AgentConfig
    from cutcue.services import Services

    moto = cs.Moto(tmp_path)
    cp = cs.ControlPlane(tmp_path, moto.url)
    try:
        token = cp.api("POST", "/v1/workers", json={"name": "Temporary worker"}).json()["token"]
        pid = cp.api("POST", "/v1/projects", json={"name": "Drain"}).json()["id"]
        up = cs.upload_file(cp, pid, fixture_dir / "market-mocha-interview.mp4")
        for _ in range(2):
            cp.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "transcribe", "asset_id": up["asset_id"]})
        agent = Agent(AgentConfig(url=cp.url, token=token, data_dir=tmp_path / "agent", min_free_mem_gb=0.1, min_free_disk_gb=0.1),
                      services=Services(settings))
        assert agent.drain(300) == 2
        assert {s for (s,) in cp.sql("SELECT status FROM jobs WHERE project_id = ?", (pid,))} == {"succeeded"}
        assert agent.drain(300) == 0  # empty queue: returns at once
    finally:
        cp.stop()
        moto.stop()
