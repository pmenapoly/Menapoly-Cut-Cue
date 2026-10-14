"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Logo, Spinner } from "./ui";

/** Single-user password gate, shown only when CUTCUE_PASSWORD is set on the server. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "in" | "out" | "down">("loading");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<{ signed_in: boolean }>("/auth/status")
      .then((s) => setState(s.signed_in ? "in" : "out"))
      .catch(() => setState("down"));
  }, []);

  if (state === "loading") return <div className="grid min-h-dvh place-items-center text-muted"><Spinner size={22} /></div>;
  if (state === "down")
    return (
      <main id="main" className="mx-auto grid min-h-dvh max-w-md place-items-center px-6 text-center">
        <div className="space-y-3">
          <div className="flex justify-center"><Logo /></div>
          <p className="text-danger">Cut Cue&apos;s engine isn&apos;t running.</p>
          <p className="text-sm text-muted">Start it on your Mac with <code className="kbd">make dev</code>, then reload this page.</p>
        </div>
      </main>
    );
  if (state === "out")
    return (
      <main id="main" className="grid min-h-dvh place-items-center px-4">
        <form className="card w-full max-w-sm space-y-4 p-6 animate-rise" onSubmit={async (e) => {
          e.preventDefault();
          try { await api.post("/auth/login", { password }); setState("in"); }
          catch (err) { setError(err instanceof ApiError ? err.message : "Sign in failed"); }
        }}>
          <Logo />
          <label className="block space-y-1.5"><span className="label">Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
          </label>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <button className="btn btn-primary w-full">Sign in</button>
        </form>
      </main>
    );
  return <>{children}</>;
}
