"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

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

  if (state === "loading") return <div className="p-8 text-muted">Loading…</div>;
  if (state === "down")
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold">Menapoly Cut Cue</h1>
        <p className="mt-2 text-danger">The API server is not reachable. Start it with <code>make dev</code>.</p>
      </div>
    );
  if (state === "out")
    return (
      <form
        className="mx-auto mt-24 flex max-w-sm flex-col gap-3 card p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post("/auth/login", { password });
            setState("in");
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Sign in failed");
          }
        }}
      >
        <h1 className="text-lg font-semibold">Menapoly Cut Cue</h1>
        <input className="input" type="password" placeholder="Password" value={password}
               onChange={(e) => setPassword(e.target.value)} autoFocus />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn btn-primary justify-center">Sign in</button>
      </form>
    );
  return <>{children}</>;
}
