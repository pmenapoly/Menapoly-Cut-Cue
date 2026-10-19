#!/usr/bin/env python3
"""First-project acceptance test for the Menapoly Cue private pilot, with a real video.

Drives the deployed control plane exactly as the phone app does: sign-in check, resumable upload with a simulated
interruption, transcription and a suggested edit on your Mac, approval, export, download and codec check. It writes a
report to data/pilot/<time>/. A step is VERIFIED only if it really ran and its checks passed; nothing is assumed.

    # one-time: sign in through Cloudflare Access on this computer
    cloudflared access login https://cue.menapoly-digital.com
    # then
    backend/.venv/bin/python scripts/pilot_acceptance.py --url https://cue.menapoly-digital.com --video ~/Movies/real.mp4

The Access token is read from `cloudflared access token -app=URL` and only sent to the URL you give; it is never
printed or saved. Approval of the suggested edit is the owner's: the script asks before approving unless --approve.
Against a local stack (`make cloud-dev`) it runs without a token: --url http://localhost:8787.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx

ROOT = Path(__file__).resolve().parents[1]
PASS, FAIL, REVIEW, BLOCKED, SKIPPED = "VERIFIED", "FAILED", "NEEDS REVIEW", "BLOCKED", "SKIPPED"
TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm"}
MiB = 1024 * 1024


class Stop(Exception):
    """A step failed in a way that makes the following steps meaningless."""


class Report:
    def __init__(self, out: Path):
        self.out, self.steps, self.facts = out, [], {}

    def step(self, number: str, title: str, status: str, details: list[str]) -> str:
        self.steps.append({"step": number, "title": title, "status": status, "details": details})
        print(f"[{status:>12}] {number}. {title}")
        for d in details:
            print(f"               {d}")
        self.write()
        return status

    def write(self) -> None:
        (self.out / "report.json").write_text(json.dumps({"steps": self.steps, "facts": self.facts}, indent=1))
        lines = ["# Menapoly Cue pilot acceptance", "", f"Run: {self.facts.get('started')}  ", f"URL: {self.facts.get('url')}  ",
                 f"Video: {self.facts.get('video')}", "", "| # | Check | Result |", "|---|---|---|"]
        lines += [f"| {s['step']} | {s['title']} | **{s['status']}** |" for s in self.steps]
        for s in self.steps:
            lines += ["", f"### {s['step']}. {s['title']}: {s['status']}"] + [f"- {d}" for d in s["details"]]
        (self.out / "report.md").write_text("\n".join(lines) + "\n")


class Client:
    def __init__(self, url: str, token: str | None):
        headers = {"cf-access-token": token} if token else {}
        local = urlparse(url).hostname in ("localhost", "127.0.0.1")
        self.http = httpx.Client(base_url=url, headers=headers, timeout=60, follow_redirects=False, trust_env=not local)
        self.storage = httpx.Client(timeout=httpx.Timeout(600, connect=20), follow_redirects=False, trust_env=not local)

    def call(self, method: str, path: str, body=None, expect=(200, 201)) -> dict:
        r = self.http.request(method, path, json=body)
        if r.status_code not in expect:
            raise Stop(f"{method} {path} → {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else {}


def access_token(url: str) -> str | None:
    if urlparse(url).hostname in ("localhost", "127.0.0.1"):
        return None
    exe = shutil.which("cloudflared")
    if not exe:
        raise SystemExit("cloudflared is not installed (brew install cloudflared), so this computer can't sign in to Access.")
    r = subprocess.run([exe, "access", "token", f"-app={url}"], capture_output=True, text=True, timeout=60)
    token = r.stdout.strip()
    if r.returncode != 0 or token.count(".") != 2:
        raise SystemExit(f"No Access session on this computer. Run: cloudflared access login {url}")
    return token


def wait_job(c: Client, job_id: str, timeout: float, label: str) -> tuple[dict, list[str]]:
    seen, start = [], time.time()
    while time.time() - start < timeout:
        job = c.call("GET", f"/v1/jobs/{job_id}")
        stage = job.get("stage")
        if stage and (not seen or seen[-1] != stage):
            seen.append(stage)
            pct = f" ({job['progress'] * 100:.0f}% measured)" if job.get("progress") is not None else ""
            print(f"               {label}: {stage}{pct}")
        if job["status"] in ("succeeded", "failed", "dead", "cancelled"):
            return job, seen
        time.sleep(5)
    raise Stop(f"{label} did not finish within {timeout / 60:.0f} minutes (last status: {job['status']})")


def ffprobe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True)
    ap.add_argument("--video", type=Path, required=True, help="a real H.264/AAC (or HEVC) video with speech")
    ap.add_argument("--approve", action="store_true", help="approve the suggested edit without asking")
    ap.add_argument("--preset", default="youtube")
    ap.add_argument("--job-timeout-min", type=float, default=180)
    ap.add_argument("--phone", action="store_true", help="also record the Android phone checks (asks you)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    url = args.url.rstrip("/")
    parsed = urlparse(url)
    local = parsed.hostname in ("localhost", "127.0.0.1")
    if parsed.scheme != "https" and not local:
        raise SystemExit("Use the https:// URL.")
    video = args.video.expanduser().resolve()
    if not video.is_file() or video.suffix.lower() not in TYPES:
        raise SystemExit(f"Need an existing .mp4/.mov/.m4v/.webm file, got {video}")
    out = args.out or ROOT / "data" / "pilot" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    rep = Report(out)
    rep.facts.update(started=datetime.now().isoformat(timespec="seconds"), url=url, video=video.name,
                     video_mb=round(video.stat().st_size / MiB, 1))
    token = access_token(url)
    c = Client(url, token)
    timeout = args.job_timeout_min * 60
    try:
        # 1. Nothing is reachable without signing in -------------------------------------------------------------
        if local:
            rep.step("1", "Private: nothing answers without Cloudflare Access", SKIPPED, ["local stack (dev sign-in)"])
        else:
            bare = httpx.Client(timeout=30, follow_redirects=False)
            leaks = []
            for path in ("/v1/projects", "/v1/status", "/v1/health", "/v1/public/review/rv_" + "A" * 43, "/"):
                r = bare.get(url + path)
                is_json = r.headers.get("content-type", "").startswith("application/json")
                if r.status_code == 200 or is_json:
                    leaks.append(f"{path} → {r.status_code} {r.headers.get('content-type', '')}")
            rep.step("1", "Private: nothing answers without Cloudflare Access", FAIL if leaks else PASS,
                     leaks or ["every probe was redirected to sign-in or refused (no app data, no app page)"])
            if leaks:
                raise Stop("the app is reachable without Access: stop the pilot (see rollback.md)")
        # 2. Signed in as the owner; pilot settings ----------------------------------------------------------------
        me = c.call("GET", "/v1/me")
        status = c.call("GET", "/v1/status")
        problems = []
        if me.get("role") != "owner":
            problems.append(f"signed in as {me.get('role')}, expected owner")
        if not local and status.get("environment") != "production":
            problems.append(f"environment is {status.get('environment')}")
        if status.get("cloud_rendering") != "disabled":
            problems.append("cloud processing is not disabled")
        if status.get("public_review") != "disabled" and not local:
            problems.append("client review links are not disabled")
        pr = c.http.get("/v1/public/review/rv_" + "A" * 43)
        if pr.status_code < 400:
            problems.append(f"public review endpoint answered {pr.status_code}")
        rep.step("2", "Owner sign-in and pilot settings (cloud off, client links off)", FAIL if problems else PASS,
                 problems or [f"role {me['role']}, environment {status['environment']}, cloud processing "
                              f"{status['cloud_rendering']}, client review links {status.get('public_review')}"])
        # 3. Mac worker --------------------------------------------------------------------------------------------
        if not status.get("workers_online"):
            rep.step("3", "Intel Mac worker online", BLOCKED, ["no worker checked in during the last 2 minutes; "
                     "start it (launchctl kickstart -k gui/$(id -u)/com.menapoly.cue.agent) and run again"])
            raise Stop("no Mac worker")
        rep.step("3", "Intel Mac worker online", PASS, [f"{status['workers_online']} worker(s) online"])
        # 4. Project + resumable upload with a simulated interruption ---------------------------------------------
        pid = c.call("POST", "/v1/projects", {"name": f"Pilot acceptance {datetime.now():%Y-%m-%d %H:%M}"})["id"]
        rep.facts["project_id"] = pid
        sha, size = hashlib.sha256(), video.stat().st_size
        with video.open("rb") as fh:
            for block in iter(lambda: fh.read(8 * MiB), b""):
                sha.update(block)
        part_size = 16 * MiB
        session = c.call("POST", f"/v1/projects/{pid}/uploads", {"filename": video.name, "content_type": TYPES[video.suffix.lower()],
                                                                "size": size, "sha256": sha.hexdigest(), "part_size": part_size})
        t0 = time.time()

        def send(parts: list[int]) -> None:
            for start in range(0, len(parts), 20):
                urls = c.call("POST", f"/v1/uploads/{session['id']}/parts", {"parts": parts[start:start + 20]})["urls"]
                with video.open("rb") as fh:
                    for item in urls:
                        fh.seek((item["part"] - 1) * session["part_size"])
                        r = c.storage.put(item["url"], content=fh.read(session["part_size"]),
                                          headers={"content-type": "application/octet-stream"})
                        if r.status_code != 200:
                            raise Stop(f"storage refused part {item['part']}: {r.status_code}")

        n = session["part_count"]
        send([1])
        # "Connection lost": ask the server what arrived, then send only the rest.
        done = c.call("GET", f"/v1/uploads/{session['id']}")["parts_done"]
        early = c.http.post(f"/v1/uploads/{session['id']}/complete")
        resumed_ok = done == [1] and (n == 1 or early.status_code == 409)
        send([p for p in range(1, n + 1) if p not in done])
        c.call("POST", f"/v1/uploads/{session['id']}/complete")
        secs = time.time() - t0
        asset = session["asset_id"]
        rep.facts["upload"] = {"mb": round(size / MiB, 1), "parts": n, "seconds": round(secs, 1)}
        rep.step("4", "Original-quality resumable upload (interrupted after part 1, resumed)", PASS if resumed_ok else FAIL,
                 [f"{size / MiB:.1f} MB in {n} part(s), {secs:.0f}s ({size / MiB / max(secs, 0.1):.1f} MB/s from this computer)",
                  f"after the interruption the server reported parts {done}; only the missing parts were sent"])
        # 5. Transcription on the Mac ------------------------------------------------------------------------------
        job = c.call("POST", f"/v1/projects/{pid}/jobs", {"type": "transcribe", "asset_id": asset})
        t0 = time.time()
        job, stages = wait_job(c, job["id"], timeout, "transcribe")
        if job["status"] != "succeeded":
            rep.step("5", "Transcription on the Intel Mac", FAIL, [f"{job['status']}: {job.get('error')}"])
            raise Stop("transcription failed")
        transcript = c.call("GET", f"/v1/assets/{job['result']['outputs'][0]}/url")["url"]
        segments = c.storage.get(transcript).json()["segments"]
        dur = job["result"].get("duration") or 0
        covered = (segments[-1]["end"] - segments[0]["start"]) if segments else 0
        rep.facts["transcribe_seconds"] = round(time.time() - t0)
        rep.step("5", "Transcription on the Intel Mac", PASS if segments else FAIL,
                 [f"engine {job['result'].get('engine')}, {len(segments)} segments covering {covered:.0f}s of {dur:.0f}s",
                  f"took {(time.time() - t0) / 60:.1f} min; stages reported: {', '.join(stages) or 'none'}"])
        # 6. Suggested edit = proposal --------------------------------------------------------------------------------
        job = c.call("POST", f"/v1/projects/{pid}/jobs", {"type": "auto_edit", "asset_id": asset})
        job, _ = wait_job(c, job["id"], timeout, "suggested edit")
        if job["status"] != "succeeded":
            rep.step("6", "Suggested edit arrives as a proposal (not applied)", FAIL, [f"{job['status']}: {job.get('error')}"])
            raise Stop("auto-edit failed")
        version = c.call("GET", f"/v1/projects/{pid}")["versions"][0]
        refused = c.http.post(f"/v1/projects/{pid}/jobs", json={"type": "render", "version_id": version["id"], "preset": args.preset})
        timeline = c.call("GET", f"/v1/versions/{version['id']}")["timeline"]
        clips = timeline.get("clips", [])
        rep.step("6", "Suggested edit arrives as a proposal (not applied)",
                 PASS if version["status"] == "proposed" and refused.status_code == 409 else FAIL,
                 [f"edit {version['number']}: {len(clips)} clips, {sum(cl['end'] - cl['start'] for cl in clips):.0f}s; status {version['status']}",
                  f"export before approval → {refused.status_code} (must be refused)"])
        # 7. Owner approval -----------------------------------------------------------------------------------------
        if not args.approve:
            answer = input("Approve this suggested edit for export? [y/N] ").strip().lower()
            if answer != "y":
                rep.step("7", "Owner approves the edit", SKIPPED, ["not approved; export not tested"])
                raise Stop("not approved")
        c.call("POST", f"/v1/versions/{version['id']}/decision", {"decision": "approved"})
        rep.step("7", "Owner approves the edit", PASS, ["approved by the owner running this test"])
        # 8. Export on the Mac, download, verify ----------------------------------------------------------------------
        job = c.call("POST", f"/v1/projects/{pid}/jobs", {"type": "render", "version_id": version["id"], "preset": args.preset})
        t0 = time.time()
        job, stages = wait_job(c, job["id"], timeout, "export")
        if job["status"] != "succeeded":
            rep.step("8", "Export on the Mac, download, verify", FAIL, [f"{job['status']}: {job.get('error')}"])
            raise Stop("export failed")
        assets = c.call("GET", f"/v1/projects/{pid}")["assets"]
        mp4 = next(a for a in assets if a["source_job_id"] == job["id"] and a["content_type"] == "video/mp4")
        dl = c.call("GET", f"/v1/assets/{mp4['id']}/url?download=1")["url"]
        final = out / "pilot-export.mp4"
        digest = hashlib.sha256()
        with c.storage.stream("GET", dl) as r, final.open("wb") as fh:
            if r.status_code != 200:
                raise Stop(f"download → {r.status_code}")
            disposition = r.headers.get("content-disposition", "")
            for chunk in r.iter_bytes(4 * MiB):
                fh.write(chunk)
                digest.update(chunk)
        info = ffprobe(final)
        codecs = {s["codec_type"]: s["codec_name"] for s in info["streams"]}
        length = float(info["format"]["duration"])
        ok = digest.hexdigest() == mp4["sha256"] and codecs.get("video") == "h264" and codecs.get("audio") == "aac" \
            and abs(length - (job["result"].get("duration") or length)) < 1.0
        rep.facts["export_seconds"] = round(time.time() - t0)
        rep.step("8", "Export on the Mac, download, verify", PASS if ok else FAIL,
                 [f"{mp4['name']}: {mp4['size'] / MiB:.1f} MB, {length:.1f}s, video {codecs.get('video')}, audio {codecs.get('audio')}",
                  "checksum matches what the Mac uploaded" if digest.hexdigest() == mp4["sha256"] else "CHECKSUM MISMATCH",
                  f"export took {(time.time() - t0) / 60:.1f} min (encoder {job['result'].get('encoder')})",
                  f"download header: {disposition or '(none: storage did not set an attachment name)'}",
                  f"saved to {final}"])
        # 9. Costs and safety switches -----------------------------------------------------------------------------
        cloud = c.http.post(f"/v1/projects/{pid}/jobs", json={"type": "transcribe", "asset_id": asset, "target": "cloud"})
        costs = c.call("GET", "/v1/costs")
        paid = [k for k in costs["by_kind"] if k["usd"] > 0]
        rep.step("9", "No paid processing; costs recorded honestly", PASS if cloud.status_code == 409 and not paid else FAIL,
                 [f"cloud job request → {cloud.status_code} (must be refused)",
                  "recorded spending this month: " + (", ".join(f"{k['kind']} ${k['usd']:.2f}" for k in costs["by_kind"]) or "none"),
                  f"stored media {costs['storage_gb']:.2f} GB ≈ ${costs['storage_estimate_usd_month']:.2f}/month above the free 10 GB"])
        # 10. Audit trail ---------------------------------------------------------------------------------------------
        actions = {row["action"] for row in c.call("GET", "/v1/audit")}
        need = {"project.create", "upload.complete", "job.create", "version.approved", "job.complete", "asset.download"}
        rep.step("10", "Audit trail", PASS if need <= actions else FAIL, [f"missing: {sorted(need - actions)}" if need - actions
                                                                         else "project, upload, jobs, approval, completion and download are recorded"])
        # 11. Android phone ---------------------------------------------------------------------------------------------
        if not args.phone:
            rep.step("11", "Android phone: install, sign in, upload, watch status, play", SKIPPED, ["run again with --phone"])
        else:
            checks = ["The app is installed on the Android home screen and opens without the browser bar",
                      "Signing in went through Cloudflare Access with your email",
                      f"The project '{pid}' shows the edit, the export and 'Mac online'",
                      "The exported video plays on the phone",
                      "A short video uploaded from the phone over mobile data reached 'Stored privately'"]
            answers = [(q, input(f"{q}? [y/N] ").strip().lower() == "y") for q in checks]
            rep.step("11", "Android phone: install, sign in, upload, watch status, play",
                     PASS if all(a for _, a in answers) else REVIEW, [f"{'yes' if a else 'NO'}: {q}" for q, a in answers])
    except Stop as exc:
        print(f"Stopped: {exc}")
        rep.facts["stopped"] = str(exc)
        rep.write()
    statuses = [s["status"] for s in rep.steps]
    print(f"\nReport: {out / 'report.md'}")
    return 0 if statuses and FAIL not in statuses and "stopped" not in rep.facts else 1


if __name__ == "__main__":
    sys.exit(main())
