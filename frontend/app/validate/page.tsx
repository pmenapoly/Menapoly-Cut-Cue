"use client";
// Playback probe used by scripts/validate.py: loads in real Chrome, plays each render and reports
// what the browser actually decoded (duration, frame size, time reached, errors) back to the API.
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, Health, renderUrl } from "@/lib/api";

type Result = { render_id: string; ok: boolean; duration: number; width: number; height: number; reached: number; error: string | null };

function playOne(pid: string, rid: string): Promise<Result> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    document.body.appendChild(v);
    const done = (ok: boolean, error: string | null) => {
      resolve({ render_id: rid, ok, duration: v.duration, width: v.videoWidth, height: v.videoHeight, reached: v.currentTime, error });
      v.pause();
      v.remove();
    };
    const timer = setTimeout(() => done(false, `timeout (readyState ${v.readyState})`), 30000);
    v.addEventListener("error", () => { clearTimeout(timer); done(false, `media error ${v.error?.code}: ${v.error?.message ?? ""}`); });
    v.addEventListener("timeupdate", () => {
      if (v.currentTime >= Math.min(2, (v.duration || 4) / 2) && v.videoWidth > 0) { clearTimeout(timer); done(true, null); }
    });
    v.src = renderUrl(pid, rid, "mp4");
    v.play().catch((e) => { clearTimeout(timer); done(false, `play() rejected: ${e}`); });
  });
}

function Probe() {
  const q = useSearchParams();
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const pid = q.get("pid") ?? "";
    const ids = (q.get("renders") ?? "").split(",").filter(Boolean);
    (async () => {
      const report: Record<string, unknown> = { run: q.get("run"), user_agent: navigator.userAgent, results: [] };
      try {
        report.health = await api.get<Health>("/health");
        report.h264_support = document.createElement("video").canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"');
        const results: Result[] = [];
        for (const rid of ids) {
          const r = await playOne(pid, rid);
          results.push(r);
          setLog((l) => [...l, JSON.stringify(r)]);
        }
        report.results = results;
      } catch (e) {
        report.error = String(e);
      }
      await api.post("/validation/playback", report);
      setLog((l) => [...l, "REPORTED"]);
    })();
  }, [q]);
  return <pre className="p-4 text-xs">{log.join("\n") || "Probing playback…"}</pre>;
}

export default function Page() {
  return <Suspense><Probe /></Suspense>;
}
