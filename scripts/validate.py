"""Menapoly Cut Cue real-world validation harness.

Runs the actual app (real server process, real HTTP API, real FFmpeg, real faster-whisper,
live Claude API, real Google Chrome) through the acceptance workflow and writes a report.
A step is VERIFIED only if it really ran and its checks passed. Missing prerequisites give
BLOCKED, inputs you did not provide give SKIPPED, never VERIFIED.

Usage (from the repo root):
    make validate MEDIA=~/Movies/episode.mp4 [CLIP_MINUTES=10]
    backend/.venv/bin/python scripts/validate.py --media FILE [--clip-minutes N] [--brief FILE] [--chrome PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx
import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

# VERIFIED: really ran and passed. FAILED: ran and failed. NEEDS REVIEW: ran, but a human must judge (e.g. listen).
# SKIPPED: not requested / input not given. BLOCKED: a prerequisite is missing (API key, Chrome, model, config).
PASS, FAIL, PARTIAL, NOT_VERIFIED, SKIPPED = "VERIFIED", "FAILED", "NEEDS REVIEW", "BLOCKED", "SKIPPED"
CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome", "google-chrome-stable",
                "chromium", "chromium-browser"]


class Run:
    def __init__(self, out: Path):
        self.out = out
        self.steps: list[dict] = []
        self.metrics: dict = {}
        self.notes: list[str] = []

    def step(self, number: str, title: str, status: str, details: list[str]) -> None:
        self.steps.append({"step": number, "title": title, "status": status, "details": details})
        print(f"\n[{status}] {number}. {title}")
        for d in details:
            print(f"    - {d}")


class MemorySampler(threading.Thread):
    """Peak RSS of the server process tree (API + Whisper + FFmpeg children), per phase."""

    def __init__(self, pid: int):
        super().__init__(daemon=True)
        self.proc = psutil.Process(pid)
        self.phase = "startup"
        self.peaks: dict[str, float] = {}
        self.stop = threading.Event()

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                procs = [self.proc, *self.proc.children(recursive=True)]
                rss = 0
                for p in procs:
                    try:
                        rss += p.memory_info().rss
                    except psutil.Error:
                        pass
                mb = rss / 1024**2
                self.peaks[self.phase] = max(self.peaks.get(self.phase, 0.0), mb)
            except psutil.Error:
                return
            time.sleep(0.25)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def ffprobe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def full_decode_errors(path: Path) -> str:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True, text=True)
    return (r.stderr or "").strip() if r.returncode == 0 else f"exit {r.returncode}: {r.stderr.strip()[-300:]}"


def find_chrome(explicit: str | None) -> str | None:
    for candidate in ([explicit] if explicit else CHROME_PATHS):
        if candidate and (Path(candidate).exists() or shutil.which(candidate)):
            return candidate if Path(candidate).exists() else shutil.which(candidate)
    return None


def chrome_cmd(chrome: str, *flags: str) -> list[str]:
    # Chrome refuses to run as root (containers) without --no-sandbox; never needed on a normal Mac login.
    root = hasattr(os, "geteuid") and os.geteuid() == 0
    return [chrome, "--headless=new", "--no-first-run", "--no-default-browser-check",
            *(["--no-sandbox"] if root else []), *flags]


def machine_info() -> dict:
    info = {"os": f"{platform.system()} {platform.release()}", "arch": platform.machine(),
            "cpu_logical": psutil.cpu_count(), "cpu_physical": psutil.cpu_count(logical=False),
            "ram_gb": round(psutil.virtual_memory().total / 1024**3, 1), "python": platform.python_version()}
    if platform.system() == "Darwin":
        try:
            info["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
            info["macos"] = platform.mac_ver()[0]
        except OSError:
            pass
    info["ffmpeg"] = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    return info


def wer(reference: str, hypothesis: str) -> float:
    norm = lambda t: re.findall(r"[a-z0-9']+", t.lower())
    r, h = norm(reference), norm(hypothesis)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def parse_srt(text: str) -> list[tuple[float, float, str]]:
    from cutcue.documents import parse_captions

    try:
        return [(c["start"], c["end"], c["text"]) for c in parse_captions(text)]
    except ValueError:
        return []


class App:
    def __init__(self, run: Run, data_dir: Path, port: int, host: str = "127.0.0.1"):
        self.run, self.port = run, port
        self.base = f"http://127.0.0.1:{port}"
        env = {**os.environ, "CUTCUE_DATA_DIR": str(data_dir), "CUTCUE_PORT": str(port), "CUTCUE_HOST": host,
               "CUTCUE_PASSWORD": "", "PYTHONUNBUFFERED": "1"}
        self.log = open(run.out / "server.log", "w")
        self.proc = subprocess.Popen([str(ROOT / "backend/.venv/bin/python"), "-m", "cutcue"], cwd=ROOT / "backend",
                                     env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.http = httpx.Client(base_url=self.base, timeout=httpx.Timeout(900.0, connect=10.0))
        self.mem = MemorySampler(self.proc.pid)
        self.mem.start()

    def wait_ready(self, timeout: float = 60) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited with code {self.proc.returncode}; see server.log")
            try:
                return self.http.get("/api/health").json()
            except httpx.HTTPError:
                time.sleep(0.5)
        raise RuntimeError("server did not become ready")

    def api(self, method: str, path: str, **kw):
        r = self.http.request(method, f"/api{path}", **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:500]}")
        return r.json() if r.content else None

    def upload(self, pid: str, path: Path) -> dict:
        size = path.stat().st_size
        up = self.api("POST", f"/projects/{pid}/uploads", json={"filename": path.name, "size": size})
        with path.open("rb") as fh:
            offset = 0
            while chunk := fh.read(8 * 1024 * 1024):
                self.api("PUT", f"/projects/{pid}/uploads/{up['id']}", params={"offset": offset}, content=chunk)
                offset += len(chunk)
        return self.api("POST", f"/projects/{pid}/uploads/{up['id']}/complete")

    def wait_jobs(self, pid: str, timeout: float = 4 * 3600) -> list[dict]:
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            jobs = self.api("GET", f"/projects/{pid}/jobs")
            active = [j for j in jobs if j["status"] in ("queued", "running")]
            if not active:
                return jobs
            line = ", ".join(f"{j['type']} {round(j['progress'] * 100)}%" for j in active)
            if line != last:
                print(f"    … {line}", flush=True)
                last = line
            time.sleep(2)
        raise RuntimeError("jobs did not finish in time")

    def stop(self) -> None:
        self.mem.stop.set()
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def job_seconds(job: dict) -> float | None:
    if job.get("started_at") and job.get("finished_at"):
        return round(job["finished_at"] - job["started_at"], 2)
    return None


def chrome_probe(app: App, chrome: str, pid: str, render_ids: list[str], label: str) -> dict | None:
    run_id = f"{label}-{int(time.time() * 1000)}"
    url = f"{app.base}/validate/?pid={pid}&renders={','.join(render_ids)}&run={run_id}"
    profile = tempfile.mkdtemp(prefix="cutcue-chrome-")
    log = open(app.run.out / "chrome.log", "a")
    proc = subprocess.Popen(chrome_cmd(chrome, "--autoplay-policy=no-user-gesture-required", f"--user-data-dir={profile}", url),
                            stdout=log, stderr=log)
    try:
        deadline = time.time() + 45 + 35 * len(render_ids)
        while time.time() < deadline:
            for report in app.api("GET", "/validation/playback"):
                if report.get("run") == run_id:
                    return report
            time.sleep(1)
        return None
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        shutil.rmtree(profile, ignore_errors=True)


def check_render(app: App, run: Run, pid: str, render: dict, expected: dict) -> tuple[bool, list[str], Path | None]:
    """Download a render and check it with ffprobe and a full decode."""
    details, ok = [], True
    if render["status"] != "succeeded":
        return False, [f"render {render['id']} status {render['status']}: {render.get('error')}"], None
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", render["sequence_name"] or "render").strip("_")[:40]
    path = run.out / f"{safe}-v{render['version_number']}-{render['quality']}-{render['id'][-4:]}.mp4"
    path.write_bytes(app.http.get(f"/api/projects/{pid}/renders/{render['id']}/mp4").content)
    info = ffprobe(path)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    dur = float(info["format"]["duration"])
    details.append(f"{path.name}: {v and v['codec_name']} {v and v['width']}x{v and v['height']}, "
                   f"audio {a and a['codec_name']}, {dur:.2f}s (timeline {expected['duration']:.2f}s), "
                   f"{path.stat().st_size / 1024**2:.1f} MB")
    if not v or not a or v["codec_name"] != "h264" or a["codec_name"] != "aac":
        ok = False
        details.append("expected H.264 video + AAC audio")
    if abs(dur - expected["duration"]) > 0.35:
        ok = False
        details.append(f"duration off by {dur - expected['duration']:+.2f}s")
    if expected.get("size") and v and (v["width"], v["height"]) != expected["size"]:
        ok = False
        details.append(f"expected {expected['size'][0]}x{expected['size'][1]}")
    errors = full_decode_errors(path)
    if errors:
        ok = False
        details.append(f"decode errors: {errors[:200]}")
    else:
        details.append("full FFmpeg decode: no errors")
    return ok, details, path


def playback_verdict(report: dict | None, render_ids: list[str]) -> tuple[str, list[str]]:
    if report is None:
        return FAIL, ["Chrome did not report back within the timeout"]
    details = [f"Chrome: {report.get('user_agent', '')[:90]}", f"H.264 canPlayType: {report.get('h264_support')!r}"]
    results = {r["render_id"]: r for r in report.get("results", [])}
    status = PASS
    for rid in render_ids:
        r = results.get(rid)
        if not r or not r["ok"]:
            status = FAIL
            details.append(f"{rid}: NOT played ({(r or {}).get('error')})")
        else:
            details.append(f"{rid}: played to {r['reached']:.1f}s, {r['width']}x{r['height']}, duration {r['duration']:.2f}s")
    return status, details


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--media", type=Path, help="Real speech video/audio file (required for a real-speech PASS)")
    ap.add_argument("--clip-minutes", type=float, default=0, help="Use only the first N minutes of --media")
    ap.add_argument("--brief", type=Path, help="Creative brief (TXT/PDF/DOCX)")
    ap.add_argument("--chrome", help="Path to Google Chrome (auto-detected on macOS)")
    ap.add_argument("--long-media", type=Path, help="A long podcast (30+ min) for the performance check (step 14)")
    ap.add_argument("--phone-check", action="store_true",
                    help="Pause to open a review link on your phone and record the result (step 15)")
    args = ap.parse_args()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = ROOT / "data" / "validation" / stamp
    out.mkdir(parents=True, exist_ok=True)
    run = Run(out)
    from cutcue.config import load_settings
    from cutcue.media import pick_video_encoder
    settings = load_settings()
    run.metrics["machine"] = machine_info()
    run.metrics["config"] = {"transcriber": settings.transcriber, "whisper_model": settings.whisper_model,
                             "compute_type": settings.whisper_compute_type, "claude_model": settings.claude_model,
                             "claude_effort": settings.claude_effort, "final_encoder": pick_video_encoder(settings.video_encoder)}
    print(f"Menapoly Cut Cue validation → {out}\n{json.dumps(run.metrics, indent=1)}")

    # --- media ---------------------------------------------------------------------------------------
    synthetic_text = None
    if args.media:
        media = args.media.expanduser().resolve()
        if not media.is_file():
            raise SystemExit(f"Media not found: {media}")
        if args.clip_minutes:
            trimmed = out / f"sample-{args.clip_minutes:g}min{media.suffix}"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(media), "-t", str(args.clip_minutes * 60),
                            "-map", "0", "-c", "copy", str(trimmed)], check=True)
            media = trimmed
        source_kind = "real media supplied by you"
    else:
        import make_fixture

        media = make_fixture.main(out / "fixture")
        synthetic_text = " ".join(s for s, _ in make_fixture.SENTENCES)
        source_kind = "SYNTHETIC speech (no --media given)"
    brief = args.brief.expanduser().resolve() if args.brief else out / "brief.txt"
    if not args.brief:
        brief.write_text("Goal: a tight podcast edit with a strong hook, long pauses removed, and one vertical "
                         "9:16 clip for Instagram Reels with captions. Tone: warm and confident.\n")

    chrome = find_chrome(args.chrome)
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    model_cached_before = hf_cache.is_dir() and any(hf_cache.glob(f"models--*faster-whisper-{settings.whisper_model}*"))

    if not (ROOT / "frontend" / "out" / "validate").is_dir():
        print("Building the browser UI (npm run build)…")
        subprocess.run(["npm", "run", "build"], cwd=ROOT / "frontend", check=True, capture_output=True)

    # --phone-check listens on the local network so your phone can open the review link (password still off).
    app = App(run, out / "appdata", free_port(), host="0.0.0.0" if args.phone_check else "127.0.0.1")
    try:
        health = app.wait_ready()
        claude_live = health["assistant_mode"] == "claude"

        # 1. Chrome launch ---------------------------------------------------------------------------------
        if not chrome:
            run.step("1", "App launches in Chrome", NOT_VERIFIED, ["Google Chrome not found; install it or pass --chrome PATH"])
        else:
            shot = out / "chrome-dashboard.png"
            with open(out / "chrome.log", "a") as log:
                subprocess.run(chrome_cmd(chrome, f"--user-data-dir={tempfile.mkdtemp()}", "--window-size=1440,900",
                                          "--virtual-time-budget=8000", f"--screenshot={shot}", app.base + "/"),
                               stdout=log, stderr=log, timeout=120)
            ok = shot.is_file() and shot.stat().st_size > 10_000
            version = subprocess.run([chrome, "--version"], capture_output=True, text=True).stdout.strip()
            is_google_chrome = "Google Chrome" in version
            run.metrics["browser"] = version
            status = (PASS if is_google_chrome else PARTIAL) if ok else FAIL
            run.step("1", "App launches in Chrome", status,
                     [f"browser: {version or chrome}" + ("" if is_google_chrome else " (not Google Chrome)"),
                      f"server up on {app.base} ({health['app']} v{health['version']})",
                      f"Chrome rendered the dashboard: {shot.name}" if ok else "Chrome screenshot missing or empty",
                      "Chrome playback of renders is checked in steps 4-6"])

        # Project + uploads ---------------------------------------------------------------------------------
        app.mem.phase = "upload+analysis"
        project = app.api("POST", "/projects", json={"name": f"Market Mocha Validation {stamp}"})
        pid = project["id"]
        t0 = time.time()
        asset = app.upload(pid, media)
        run.metrics["upload_seconds"] = round(time.time() - t0, 2)
        app.upload(pid, brief)
        run.metrics["media"] = {"file": media.name, "kind": source_kind, "duration_s": asset["duration"],
                                "size_mb": round(asset["size"] / 1024**2, 1)}
        app.mem.phase = "transcription"
        jobs = app.wait_jobs(pid)
        by_type = {j["type"]: j for j in jobs if j["payload"].get("asset_id") == asset["id"]}
        analyze, transcribe = by_type.get("analyze"), by_type.get("transcribe")
        run.metrics["analysis_seconds"] = analyze and job_seconds(analyze)

        # 2. Whisper ---------------------------------------------------------------------------------------
        segs = app.api("GET", f"/projects/{pid}/assets/{asset['id']}/transcript")
        details = [f"media: {media.name}, {asset['duration']:.1f}s, {source_kind}"]
        if settings.transcriber != "faster-whisper":
            status = NOT_VERIFIED
            details.append(f"transcriber is '{settings.transcriber}', not faster-whisper")
        elif not transcribe or transcribe["status"] != "succeeded":
            status = FAIL
            details.append(f"transcribe job: {transcribe and transcribe['status']}: {transcribe and transcribe['error']}")
        elif not segs:
            status = FAIL
            details.append("transcription produced no segments")
        else:
            secs = job_seconds(transcribe)
            run.metrics["transcription"] = {"seconds": secs, "realtime_factor": round(secs / asset["duration"], 3),
                                            "model": settings.whisper_model, "segments": len(segs),
                                            "includes_model_download": not model_cached_before}
            details += [f"{len(segs)} segments in {secs:.1f}s = {secs / asset['duration']:.2f}x realtime "
                        f"(Whisper '{settings.whisper_model}', {'incl. first-time model download' if not model_cached_before else 'model already cached'})",
                        *[f"[{s['start']:.1f}-{s['end']:.1f}] {s['text'][:100]}" for s in segs[:3]]]
            words_ok = sum(1 for s in segs if s["words"]) / len(segs)
            details.append(f"word timestamps on {words_ok:.0%} of segments")
            if synthetic_text:
                w = wer(synthetic_text, " ".join(s["text"] for s in segs))
                run.metrics["transcription"]["wer_vs_script"] = round(w, 3)
                details.append(f"word error rate vs. known script: {w:.1%}")
                status = PARTIAL
                details.append("synthetic speech only: rerun with --media <real recording> for a real-speech PASS")
            else:
                status = PASS
        (out / "transcript.txt").write_text("\n".join(f"[{s['start']:.2f}-{s['end']:.2f}] {s['text']}" for s in segs))
        run.step("2", "Faster-Whisper downloads and transcribes speech", status, details)
        if not segs:
            raise RuntimeError("Cannot continue without a transcript")

        # 3. Claude proposes an edit ------------------------------------------------------------------------
        app.mem.phase = "claude"
        chat_costs: list[dict] = []

        def chat(message: str) -> dict:
            t = time.time()
            r = app.api("POST", f"/projects/{pid}/chat", json={"message": message})
            r["latency_s"] = round(time.time() - t, 1)
            chat_costs.append({"message": message[:60], "latency_s": r["latency_s"], "cost_usd": r.get("cost_usd", 0),
                               "usage": r.get("usage")})
            return r

        def ask_for_proposal(message: str) -> tuple[dict, dict | None]:
            r = chat(message)
            if not r.get("proposal_ids") and not r.get("error"):
                r = chat("Please call propose_edit now with your best plan.")
            prop = app.api("GET", f"/projects/{pid}/proposals")
            prop = next((p for p in prop if p["id"] in r.get("proposal_ids", [])), None)
            return r, prop

        rough = None
        if not claude_live:
            run.step("3", "Live Claude analyzes transcript and proposes a valid edit", NOT_VERIFIED,
                     ["ANTHROPIC_API_KEY is not set in .env (app is in local test mode)"])
            # Keep exercising the render path with a deterministic plan, clearly not Claude.
            r = chat("Make a rough cut with a hook and remove pauses")
            rough = app.api("GET", f"/projects/{pid}/proposals")[-1] if r.get("proposal_ids") else None
        else:
            r, rough = ask_for_proposal(
                "Read the brief and the transcript, then propose a rough cut named 'Rough cut': open with the single "
                "most compelling 10-30 second moment as a hook, followed by the main content with long pauses removed "
                "(remove_pauses enabled). Cite the timestamps you chose.")
            details = [f"reply in {r['latency_s']}s, cost ${r.get('cost_usd', 0):.4f}, usage {r.get('usage')}",
                       f"reply: {r['reply'][:300]}"]
            if r.get("error") or not rough:
                run.step("3", "Live Claude analyzes transcript and proposes a valid edit", FAIL,
                         details + ["no valid proposal was created"])
            else:
                seq = rough["plan"]["sequences"][0]
                clips = seq["timeline"]["clips"]
                grounded = all(c["asset_id"] == asset["id"] and 0 <= c["start"] < c["end"] <= asset["duration"] + 0.05 for c in clips)
                details += [f"proposal '{rough['title']}' by {rough['created_by']}: {len(rough['plan']['sequences'])} sequence(s), "
                            f"first = {seq['clip_count']} clips, {seq['duration']:.1f}s",
                            f"first clip {clips[0]['start']:.2f}-{clips[0]['end']:.2f}s; all clips inside the source: {grounded}"]
                ok = rough["created_by"] == "claude" and rough["status"] == "pending" and grounded
                run.step("3", "Live Claude analyzes transcript and proposes a valid edit", PASS if ok else FAIL, details)

        # 4. Approve + render + Chrome playback ---------------------------------------------------------------
        app.mem.phase = "preview render"
        render_ids: dict[str, str] = {}
        if not rough:
            run.step("4", "Approve edit and render a playable MP4", NOT_VERIFIED, ["no proposal to approve"])
        else:
            approved = app.api("POST", f"/projects/{pid}/proposals/{rough['id']}/approve")
            app.wait_jobs(pid)
            created = approved["result"]["created"][0]
            rough_seq_id = created["sequence_id"]
            render = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == created["render_id"])
            rjob = next(j for j in app.api("GET", f"/projects/{pid}/jobs") if j["id"] == render["job_id"])
            expected = {"duration": approved["plan"]["sequences"][0]["duration"],
                        "size": {"16:9": (640, 360), "9:16": (360, 640), "1:1": (480, 480)}[approved["plan"]["sequences"][0]["timeline"]["aspect"]]}
            ok, details, _ = check_render(app, run, pid, render, expected)
            run.metrics["preview_render_seconds"] = job_seconds(rjob)
            details.insert(0, f"preview render took {job_seconds(rjob)}s for {expected['duration']:.1f}s of output")
            status = PASS if ok else FAIL
            if chrome:
                pstatus, pdetails = playback_verdict(chrome_probe(app, chrome, pid, [render["id"]], "rough"), [render["id"]])
                details += pdetails
                status = status if pstatus == PASS else FAIL
            else:
                details.append("Chrome playback not checked (Chrome not found)")
                status = PARTIAL if ok else FAIL
            if not claude_live:
                details.append("edit came from the local test planner, not Claude")
            run.step("4", "Approve edit and render a playable MP4", status, details)
            render_ids["rough_v1"] = render["id"]

            # 5. Revision via chat -------------------------------------------------------------------------------
            app.mem.phase = "revision"
            if not claude_live:
                run.step("5", "Revision through chat renders a new version", NOT_VERIFIED, ["needs live Claude"])
            else:
                r, rev = ask_for_proposal(
                    f"Revise the existing sequence {rough_seq_id} (pass this sequence_id): make the opening hook shorter, "
                    "under 12 seconds, and turn on burned-in captions. Keep the rest as it is.")
                details = [f"reply in {r['latency_s']}s, cost ${r.get('cost_usd', 0):.4f}", f"reply: {r['reply'][:200]}"]
                if not rev:
                    run.step("5", "Revision through chat renders a new version", FAIL, details + ["no revision proposal"])
                else:
                    targets = [s["sequence_id"] for s in rev["plan"]["sequences"]]
                    details.append(f"proposal targets sequences {targets} (expected {rough_seq_id})")
                    approved2 = app.api("POST", f"/projects/{pid}/proposals/{rev['id']}/approve")
                    app.wait_jobs(pid)
                    seqs = {s["id"]: s for s in app.api("GET", f"/projects/{pid}/sequences")}
                    entry = next((c for c in approved2["result"]["created"] if c["sequence_id"] == rough_seq_id), None)
                    ok = entry is not None
                    if entry:
                        versions = seqs[rough_seq_id]["versions"]
                        details.append(f"sequence now at v{versions[-1]['number']} ({len(versions)} versions)")
                        cmp = app.api("GET", f"/projects/{pid}/compare", params={"a": created["version_id"], "b": entry["version_id"]})
                        details.append(f"compare v{cmp['a']['number']}→v{cmp['b']['number']}: {cmp['a']['duration']:.1f}s→"
                                       f"{cmp['b']['duration']:.1f}s, {len(cmp['only_in_a'])} clips removed, {len(cmp['only_in_b'])} added")
                        spec = next(s for s in approved2["plan"]["sequences"] if s["sequence_id"] == rough_seq_id)
                        render2 = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == entry["render_id"])
                        rok, rdetails, _ = check_render(app, run, pid, render2, {"duration": spec["duration"]})
                        details += rdetails
                        ok = ok and rok and len(versions) >= 2 and cmp["only_in_a"] + cmp["only_in_b"] != []
                        if chrome:
                            pstatus, pdetails = playback_verdict(chrome_probe(app, chrome, pid, [render2["id"]], "rev"), [render2["id"]])
                            details += pdetails
                            ok = ok and pstatus == PASS
                        render_ids["rough_v2"] = render2["id"]
                    else:
                        details.append("revision did not update the existing sequence")
                    run.step("5", "Revision through chat renders a new version", PASS if ok else FAIL, details)

        # 6. Vertical 9:16 final export + SRT -----------------------------------------------------------------
        app.mem.phase = "vertical final render"
        details = []
        vertical_version = None
        if claude_live:
            r, vp = ask_for_proposal("Create one new vertical 9:16 short clip named 'Vertical clip' of 20-45 seconds: one "
                                     "self-contained idea with a strong first line, burn_captions true.")
            details.append(f"Claude reply in {r['latency_s']}s, cost ${r.get('cost_usd', 0):.4f}")
            if vp:
                done = app.api("POST", f"/projects/{pid}/proposals/{vp['id']}/approve")
                app.wait_jobs(pid)
                vertical_version = done["result"]["created"][0]["version_id"]
        else:
            # Manual (non-AI) timeline from real transcript segments, to test the 9:16 + SRT pipeline itself.
            start, end = segs[0]["start"], segs[0]["end"]
            for s in segs[1:]:
                if s["end"] - start > 30:
                    break
                end = s["end"]
            seq = app.api("POST", f"/projects/{pid}/sequences", json={"name": "Vertical clip", "timeline": {
                "aspect": "9:16", "burn_captions": True, "normalize_audio": True,
                "clips": [{"asset_id": asset["id"], "start": max(0, start - 0.15), "end": min(asset["duration"], end + 0.15)}]}})
            vertical_version = app.api("GET", f"/projects/{pid}/sequences")[-1]["current_version_id"]
            details.append("timeline built by the harness from transcript segments (not AI): tests the render path only")
        if not vertical_version:
            run.step("6", "Vertical 9:16 export with SRT captions", FAIL, details + ["no vertical sequence was created"])
        else:
            version = app.api("GET", f"/projects/{pid}/versions/{vertical_version}")
            final = app.api("POST", f"/projects/{pid}/renders", json={"version_id": vertical_version, "quality": "final", "wav": True})
            app.wait_jobs(pid)
            final = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == final["id"])
            fjob = next(j for j in app.api("GET", f"/projects/{pid}/jobs") if j["id"] == final["job_id"])
            run.metrics["final_vertical_render"] = {"seconds": job_seconds(fjob), "output_seconds": version["stats"]["duration"],
                                                    "encoder": (fjob.get("result") or {}).get("encoder")}
            ok, rdetails, mp4 = check_render(app, run, pid, final, {"duration": version["stats"]["duration"], "size": (1080, 1920)})
            details += [f"final 1080x1920 render took {job_seconds(fjob)}s for {version['stats']['duration']:.1f}s "
                        f"(encoder {(fjob.get('result') or {}).get('encoder')})", *rdetails]
            srt_text = app.http.get(f"/api/projects/{pid}/renders/{final['id']}/srt").text
            (out / "vertical.srt").write_text(srt_text)
            cues = parse_srt(srt_text)
            in_range = all(0 <= a < b <= version["stats"]["duration"] + 0.5 for a, b, _ in cues)
            ordered = all(cues[i][0] <= cues[i + 1][0] for i in range(len(cues) - 1))
            details.append(f"SRT: {len(cues)} cues, inside clip duration: {in_range}, in order: {ordered}; "
                           f"first: {cues[0][2][:60] if cues else '-'}")
            ok = ok and bool(cues) and in_range and ordered
            if cues and mp4:
                at = (cues[0][0] + cues[0][1]) / 2
                frame = out / "vertical-caption-frame.jpg"
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(mp4), "-frames:v", "1", str(frame)])
                details.append(f"frame with burned-in caption saved for you to check: {frame.name}")
            wav = app.http.get(f"/api/projects/{pid}/renders/{final['id']}/wav")
            details.append(f"WAV export: {'ok' if wav.content[:4] == b'RIFF' else 'MISSING'} ({len(wav.content) / 1024**2:.1f} MB)")
            if chrome:
                pstatus, pdetails = playback_verdict(chrome_probe(app, chrome, pid, [final["id"]], "vertical"), [final["id"]])
                details += pdetails
                ok = ok and pstatus == PASS
            status = PASS if ok else FAIL
            if ok and not chrome:
                status = PARTIAL
            run.step("6", "Vertical 9:16 export with SRT captions", status, details)

        # 16:9 final export timing (rough cut, latest version)
        if render_ids:
            app.mem.phase = "16:9 final render"
            seq = next((s for s in app.api("GET", f"/projects/{pid}/sequences") if s["versions"]), None)
            if seq:
                fr = app.api("POST", f"/projects/{pid}/renders", json={"version_id": seq["current_version_id"], "quality": "final"})
                app.wait_jobs(pid)
                fr = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == fr["id"])
                fj = next(j for j in app.api("GET", f"/projects/{pid}/jobs") if j["id"] == fr["job_id"])
                run.metrics["final_16x9_render"] = {"seconds": job_seconds(fj), "output_seconds": seq["duration"],
                                                    "status": fr["status"], "encoder": (fj.get("result") or {}).get("encoder")}

        # 8-11. New features on the same real media ------------------------------------------------------------
        app.mem.phase = "speakers"
        sp = app.api("GET", f"/projects/{pid}/assets/{asset['id']}/speakers")
        djob = next((j for j in app.api("GET", f"/projects/{pid}/jobs") if j["type"] == "diarize"), None)
        if djob and djob["status"] == "succeeded" and sp.get("labels"):
            talk = ", ".join(f"{k}: {v['talk_seconds']:.0f}s" for k, v in sp["labels"].items())
            run.metrics["speakers"] = {"method": sp["method"], "confidence": sp.get("confidence"), "count": len(sp["labels"]),
                                       "seconds": job_seconds(djob)}
            run.step("8", "Speaker detection", PARTIAL,
                     [f"method {sp['method']}, confidence {sp.get('confidence')}, {len(sp['labels'])} speaker(s) ({talk}), "
                      f"took {job_seconds(djob)}s",
                      "accuracy on real voices needs your check: listen to transcript.txt lines against the S1/S2 labels"])
            (out / "transcript.txt").write_text("\n".join(
                f"[{s['start']:.2f}-{s['end']:.2f}] {s.get('speaker') or '?'}: {s['text']}"
                for s in app.api("GET", f"/projects/{pid}/assets/{asset['id']}/transcript")))
        else:
            run.step("8", "Speaker detection", FAIL, [f"diarize job: {djob and djob['status']}: {djob and djob['error']}"])

        app.mem.phase = "auto-edit"
        try:
            prop = app.api("POST", f"/projects/{pid}/auto-edit", json={"asset_id": asset["id"]})
            report = prop["plan"]["notes"]["auto_edit"]
            done = app.api("POST", f"/projects/{pid}/proposals/{prop['id']}/approve")
            app.wait_jobs(pid)
            created = done["result"]["created"][0]
            rend = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == created["render_id"])
            ok, details, mp4 = check_render(app, run, pid, rend, {"duration": done["plan"]["sequences"][0]["duration"]})
            details.insert(0, prop["rationale"][:300])
            if mp4:
                log = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(mp4), "-af", "silencedetect=noise=-45dB:d=1.2",
                                      "-f", "null", "-"], capture_output=True, text=True).stderr
                long_gaps = re.findall(r"silence_duration: ([\d.]+)", log)
                details.append(f"silences >= 1.2 s left in the edit: {len(long_gaps)} (music beds or deliberate beats can be valid)")
            run.metrics["auto_edit"] = {"removed_seconds": report["removed_seconds"], "pauses_tightened": report["pauses_tightened"],
                                        "fillers_removed": len(report["fillers_removed"])}
            details.append("listen for clipped words at cuts; the tests guarantee cuts land between words only on synthetic speech")
            run.step("9", "Podcast auto-edit renders", PASS if ok else FAIL, details)
        except Exception as exc:
            run.step("9", "Podcast auto-edit renders", FAIL, [f"{type(exc).__name__}: {exc}"])

        app.mem.phase = "clip factory"
        try:
            prop = app.api("POST", f"/projects/{pid}/clip-factory", json={"count": 2, "titles": True})
            done = app.api("POST", f"/projects/{pid}/proposals/{prop['id']}/approve")
            app.wait_jobs(pid)
            renders = {x["id"]: x for x in app.api("GET", f"/projects/{pid}/renders")}
            details, all_ok = [prop["rationale"][:300]], True
            for created, spec in zip(done["result"]["created"], done["plan"]["sequences"]):
                ok, d, _ = check_render(app, run, pid, renders[created["render_id"]], {"duration": spec["duration"], "size": (360, 640)})
                cues = parse_srt(app.http.get(f"/api/projects/{pid}/renders/{created['render_id']}/srt").text)
                ordered = all(a[1] <= b[0] + 0.001 for a, b in zip(cues, cues[1:]))
                d.append(f"{spec['name']}: {len(cues)} caption cues, non-overlapping: {ordered}")
                all_ok = all_ok and ok and bool(cues) and ordered
                details += d
            run.step("10", "Clip Factory 9:16 clips with captions", PASS if all_ok else FAIL, details)
        except Exception as exc:
            run.step("10", "Clip Factory 9:16 clips with captions", FAIL, [f"{type(exc).__name__}: {exc}"])

        app.mem.phase = "audio enhancement"
        try:
            from cutcue.audio import integrated_loudness
            seg_end = min(asset["duration"], 60.0)
            app.api("POST", f"/projects/{pid}/sequences", json={"name": "Audio check", "timeline": {
                "clips": [{"asset_id": asset["id"], "start": 0, "end": seg_end}],
                "audio": {"denoise": "light", "voice_eq": True, "compress": True, "loudness_target": -16}}})
            vid = app.api("GET", f"/projects/{pid}/sequences")[-1]["current_version_id"]
            r = app.api("POST", f"/projects/{pid}/renders", json={"version_id": vid, "quality": "final"})
            app.wait_jobs(pid)
            r = next(x for x in app.api("GET", f"/projects/{pid}/renders") if x["id"] == r["id"])
            path = run.out / "audio-enhanced.mp4"
            path.write_bytes(app.http.get(f"/api/projects/{pid}/renders/{r['id']}/mp4").content)
            lufs = integrated_loudness(path)
            ok = r["status"] == "succeeded" and abs(lufs - (-16)) <= 1.0
            run.metrics["audio_enhancement"] = {"lufs": lufs, "noise_floor_db": r["info"].get("noise_floor_db"),
                                                "input_lufs": r["info"].get("measured_input_lufs")}
            run.step("11", "Audio enhancement (denoise, EQ, compression, -16 LUFS)", PASS if ok else FAIL,
                     [f"first {seg_end:.0f}s: input {r['info'].get('measured_input_lufs')} LUFS, noise floor "
                      f"{r['info'].get('noise_floor_db')} dB -> output {lufs:.1f} LUFS (target -16 ±1)",
                      f"listen to {path.name}: denoise strength is a judgement call on real rooms"])
        except Exception as exc:
            run.step("11", "Audio enhancement (denoise, EQ, compression, -16 LUFS)", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 12-13. Menapoly Cue 2.0 layer on the same real project -----------------------------------------------
        app.mem.phase = "cue 2.0"
        try:
            details, ok = [], True
            app.api("PATCH", f"/cue/projects/{pid}", json={"client_name": "Validation Client"})
            over = app.api("GET", f"/cue/projects/{pid}")
            details.append(f"project status: {over['project']['status']['label']}, stage {over['project']['stage']}, "
                           f"client {over['project']['client_name']}")
            done = [r for r in over["renders"] if r["status"] == "succeeded"]
            if not done:
                raise RuntimeError("no finished render to share")
            link = app.api("POST", f"/cue/projects/{pid}/review-links", json={"render_id": done[0]["id"]})
            public = httpx.Client(base_url=app.base, timeout=60)  # no owner session: what a client sees
            part = public.get(f"/api/public/review/{link['token']}/media", headers={"Range": "bytes=0-1023"})
            ok &= part.status_code == 206 and len(part.content) == 1024
            details.append(f"review link streams with byte ranges: HTTP {part.status_code}")
            ev = public.post(f"/api/public/review/{link['token']}/events",
                             json={"kind": "changes_requested", "author": "Validator", "body": "Shorter intro", "at_seconds": 3})
            ok &= ev.status_code == 201
            kinds = [n["kind"] for n in app.api("GET", "/cue/notifications")["items"]]
            ok &= "review_changes_requested" in kinds and "render_done" in kinds
            details.append(f"notifications: {sorted(set(kinds))}")
            conn = {i["key"]: i for i in app.api("GET", "/cue/connections")["items"]}
            details.append("connections: " + ", ".join(f"{k}={v['status']}" for k, v in conn.items()))
            ok &= conn["ffmpeg"]["status"] == "ready"
            app.api("POST", f"/cue/projects/{pid}/review-links/{link['id']}/revoke")
            ok &= public.get(f"/api/public/review/{link['token']}").status_code == 404
            details.append("revoked link returns 404")
            details.append("open http://127.0.0.1:<port>/ in Chrome yourself to judge the Home/Projects/Inbox screens; "
                           "this step checks the API and data, not the visuals")
            run.step("12", "Cue 2.0: client, status, review link, client feedback, notifications", PASS if ok else FAIL, details)
        except Exception as exc:
            run.step("12", "Cue 2.0: client, status, review link, client feedback, notifications", FAIL, [f"{type(exc).__name__}: {exc}"])

        app.mem.phase = "ask cue"
        try:
            name = app.api("GET", f"/projects/{pid}")["name"]
            r = app.api("POST", "/cue/ask", json={"message": f"What's the status of {name}, and make 2 short clips from it."})
            pending = [a for a in r["actions"] if a["status"] == "proposed"]
            executed = [a for a in r["actions"] if a["status"] != "proposed"]
            details = [f"mode {r['mode']}, cost ${r.get('cost_usd', 0):.4f}", f"reply: {r['reply'][:300]}",
                       f"proposed actions: {[a['summary'] for a in pending]}"]
            if executed:
                run.step("13", "Ask Cue (live Claude) proposes, never executes", FAIL, details + ["an action ran without approval"])
            elif r["mode"] != "claude":
                run.step("13", "Ask Cue (live Claude) proposes, never executes", NOT_VERIFIED,
                         details + ["ANTHROPIC_API_KEY not set: only the local planner answered"])
            else:
                run.step("13", "Ask Cue (live Claude) proposes, never executes", PASS if pending else PARTIAL,
                         details + ([] if pending else ["Claude answered but proposed no action; judge the reply yourself"]))
        except Exception as exc:
            run.step("13", "Ask Cue (live Claude) proposes, never executes", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 14. Long podcast performance --------------------------------------------------------------------------
        if not args.long_media:
            run.step("14", "Long podcast (30+ min): transcription, auto-edit, render, memory", SKIPPED,
                     ["pass --long-media ~/Movies/full-episode.mp4 (make validate LONG=…)"])
        else:
            try:
                long_media = args.long_media.expanduser().resolve()
                app.mem.phase = "long podcast"
                lp = app.api("POST", "/projects", json={"name": f"Long podcast {stamp}"})["id"]
                t0 = time.time()
                la = app.upload(lp, long_media)
                app.wait_jobs(lp, timeout=8 * 3600)
                la = app.api("GET", f"/projects/{lp}/assets/{la['id']}")
                jobs_l = {j["type"]: j for j in app.api("GET", f"/projects/{lp}/jobs")}
                tr = jobs_l.get("transcribe")
                prop = app.api("POST", f"/projects/{lp}/auto-edit", json={"asset_id": la["id"]})
                done = app.api("POST", f"/projects/{lp}/proposals/{prop['id']}/approve")
                app.wait_jobs(lp, timeout=8 * 3600)
                rend = next(x for x in app.api("GET", f"/projects/{lp}/renders") if x["id"] == done["result"]["created"][0]["render_id"])
                rj = next(j for j in app.api("GET", f"/projects/{lp}/jobs") if j["id"] == rend["job_id"])
                minutes = (la["duration"] or 0) / 60
                peak = max(app.mem.peaks.get("long podcast", 0), 0)
                details = [f"{long_media.name}: {minutes:.1f} min",
                           f"transcription {job_seconds(tr)}s ({(job_seconds(tr) or 0) / max(la['duration'] or 1, 1):.2f}x realtime)" if tr else "no transcription job",
                           f"auto-edit removed {prop['plan']['notes']['auto_edit']['removed_seconds']:.0f}s",
                           f"preview render of the full edit: {job_seconds(rj)}s, status {rend['status']}",
                           f"peak memory during this phase: {peak:.0f} MB (16 GB machine)",
                           f"wall clock total: {time.time() - t0:.0f}s"]
                run.metrics["long_podcast"] = {"minutes": minutes, "transcribe_s": tr and job_seconds(tr),
                                               "render_s": job_seconds(rj), "peak_mb": peak}
                ok = rend["status"] == "succeeded" and tr and tr["status"] == "succeeded" and minutes >= 30
                run.step("14", "Long podcast (30+ min): transcription, auto-edit, render, memory",
                         PASS if ok else (PARTIAL if rend["status"] == "succeeded" else FAIL),
                         details + ([] if minutes >= 30 else ["shorter than 30 min: not a long-podcast test"]))
            except Exception as exc:
                run.step("14", "Long podcast (30+ min): transcription, auto-edit, render, memory", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 15. Mobile review link ----------------------------------------------------------------------------------
        try:
            done_r = [r for r in app.api("GET", f"/projects/{pid}/renders") if r["status"] == "succeeded"]
            link = app.api("POST", f"/cue/projects/{pid}/review-links", json={"render_id": done_r[0]["id"], "label": "Phone check"})
            phone = httpx.Client(base_url=app.base, timeout=60, headers={
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"})
            page = phone.get(f"/review/?t={link['token']}")
            part = phone.get(f"/api/public/review/{link['token']}/media", headers={"Range": "bytes=0-65535"})
            details = [f"review page HTTP {page.status_code}, video byte-range HTTP {part.status_code} ({len(part.content)} bytes)",
                       "served without the owner session, as a phone would see it"]
            api_ok = page.status_code == 200 and part.status_code == 206
            if not args.phone_check:
                run.step("15", "Mobile review link", PARTIAL if api_ok else FAIL, details + [
                    "the phone itself was not used: rerun with --phone-check (needs CUTCUE_HOST=0.0.0.0 or a tunnel)"])
            else:
                lan = socket.gethostname()
                url = f"http://{lan}:{app.port}/review/?t={link['token']}"
                print(f"\n>>> On your phone (same Wi-Fi), open:\n    {url}\n    Play the video, leave a note, then come back here.")
                answer = input("Did the video play and did the note send? [y/n] ").strip().lower()
                notes = app.api("GET", f"/cue/projects/{pid}")["feedback"]
                details.append(f"notes received from the phone: {len(notes)}")
                run.step("15", "Mobile review link", PASS if api_ok and answer == "y" and notes else FAIL, details)
        except Exception as exc:
            run.step("15", "Mobile review link", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 16. Database backup and restore ----------------------------------------------------------------------
        try:
            from cutcue.backup import create_backup, restore_backup, verify_backup
            done_r = [r for r in app.api("GET", f"/projects/{pid}/renders") if r["status"] == "succeeded"]
            dest = create_backup(out / "appdata", out / "backups")
            check = verify_backup(dest)
            restored = restore_backup(dest, out / "restored-data")
            app2 = App(run, out / "restored-data", free_port())
            try:
                app2.wait_ready()
                same = app2.api("GET", f"/cue/projects/{pid}")["project"]["id"] == pid
                r0 = done_r[0]["id"]
                blob = app2.http.get(f"/api/projects/{pid}/renders/{r0}/mp4").content
                same_bytes = blob == app.http.get(f"/api/projects/{pid}/renders/{r0}/mp4").content
            finally:
                app2.stop()
            ok = check["ok"] and restored["counts"] == check["counts"] and same and same_bytes
            run.step("16", "Database backup and restore", PASS if ok else FAIL,
                     [f"backup: {check['files']} files, counts {check['counts']}",
                      f"restored server serves the same project: {same}; render bytes identical: {same_bytes}"])
        except Exception as exc:
            run.step("16", "Database backup and restore", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 17-18. Client portal connector and email (only if you configured them) ------------------------------------
        relay = app.api("GET", "/cue/relay")
        if not relay["configured"]:
            run.step("17", "Publish to the client portal (Relay)", NOT_VERIFIED, [relay["problem"] or "not configured"])
        else:
            try:
                act = app.api("POST", "/cue/actions", json={"kind": "publish_to_relay", "project_id": pid})
                res = app.api("POST", f"/cue/actions/{act['id']}/approve")
                run.step("17", "Publish to the client portal (Relay)", PASS if res["status"] == "executed" else FAIL,
                         [res.get("error") or res["result"].get("note", ""), "check the new review version in Relay yourself"])
            except Exception as exc:
                run.step("17", "Publish to the client portal (Relay)", FAIL, [f"{type(exc).__name__}: {exc}"])
        email = app.api("GET", "/cue/email")
        if not email["configured"]:
            run.step("18", "Email notifications", NOT_VERIFIED, ["set CUE_SMTP_HOST, CUE_EMAIL_FROM, CUE_EMAIL_TO in .env"])
        else:
            try:
                r = app.api("POST", "/cue/email/test")
                run.step("18", "Email notifications", PARTIAL if r["status"] == "sent" else FAIL,
                         [f"test email: {r['status']} {r.get('error') or ''}", f"check {email['to']}'s inbox (and spam folder)"])
            except Exception as exc:
                run.step("18", "Email notifications", FAIL, [f"{type(exc).__name__}: {exc}"])

        # 7. Measurements --------------------------------------------------------------------------------------
        project = app.api("GET", f"/projects/{pid}")
        run.metrics["peak_memory_mb"] = {k: round(v) for k, v in app.mem.peaks.items()}
        run.metrics["claude"] = {"turns": chat_costs, "project_spend_usd": round(project["spent_usd"], 4),
                                 "live": claude_live}
        tr = run.metrics.get("transcription")
        details = [f"transcription: {tr['seconds']}s (realtime factor {tr['realtime_factor']})" if tr
                   else "transcription: not measured (no real faster-whisper run)",
                   f"analysis (pauses+scenes): {run.metrics.get('analysis_seconds')}s",
                   f"preview render: {run.metrics.get('preview_render_seconds')}s",
                   f"final 9:16: {run.metrics.get('final_vertical_render')}",
                   f"final 16:9: {run.metrics.get('final_16x9_render')}",
                   f"peak memory (server + Whisper + FFmpeg) by phase, MB: {run.metrics['peak_memory_mb']}",
                   f"Claude spend: ${project['spent_usd']:.4f} over {len(chat_costs)} turns (estimated from token usage)"
                   if claude_live else "Claude spend: not measured (no live Claude)"]
        measured = all(run.metrics.get(k) for k in ("transcription", "preview_render_seconds", "final_vertical_render"))
        renders_measured = bool(run.metrics.get("preview_render_seconds") or run.metrics.get("final_vertical_render"))
        status = PASS if measured and claude_live else PARTIAL if renders_measured else FAIL
        run.step("7", "Measure transcription, rendering, memory and API cost", status, details)
    except Exception as exc:  # report what happened instead of a bare traceback
        run.step("!", "Validation aborted", FAIL, [f"{type(exc).__name__}: {exc}", "see server.log in the report folder"])
    finally:
        app.stop()

    write_report(run)
    return 0 if all(s["status"] in (PASS,) for s in run.steps) else 1


def write_report(run: Run) -> None:
    (run.out / "report.json").write_text(json.dumps({"steps": run.steps, "metrics": run.metrics}, indent=1, default=str))
    counts = {k: sum(1 for s in run.steps if s["status"] == k) for k in (PASS, FAIL, PARTIAL, SKIPPED, NOT_VERIFIED)}
    lines = [f"# Menapoly Cut Cue validation report", "", f"Run folder: `{run.out}`", "",
             " · ".join(f"**{k}**: {v}" for k, v in counts.items()), "",
             "VERIFIED = really ran and passed · FAILED = ran and failed · NEEDS REVIEW = ran, a person must judge · "
             "SKIPPED = input not given · BLOCKED = prerequisite missing", "",
             "| Step | Result |", "|---|---|"]
    lines += [f"| {s['step']}. {s['title']} | **{s['status']}** |" for s in run.steps]
    for s in run.steps:
        lines += ["", f"## {s['step']}. {s['title']}: {s['status']}", ""] + [f"- {d}" for d in s["details"]]
    lines += ["", "## Raw metrics", "", "```json", json.dumps(run.metrics, indent=1, default=str), "```"]
    (run.out / "report.md").write_text("\n".join(lines))
    print(f"\nReport: {run.out / 'report.md'}")


if __name__ == "__main__":
    raise SystemExit(main())
