"use client";
// Searchable keyboard shortcut guide (press ?). Rendered from lib/shortcuts.ts.
import { useMemo, useState } from "react";
import { SHORTCUTS } from "@/lib/shortcuts";
import { Dialog } from "./ui";

export default function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    return SHORTCUTS.map((g) => ({
      ...g,
      items: g.items.filter((s) => !term || `${s.action} ${s.keys.join(" ")} ${g.group}`.toLowerCase().includes(term)),
    })).filter((g) => g.items.length);
  }, [q]);
  return (
    <Dialog open={open} onClose={() => { setQ(""); onClose(); }} title="Keyboard shortcuts" wide>
      <label className="block">
        <span className="sr-only">Search shortcuts</span>
        <input className="input min-h-11" placeholder="Search: split, undo, captions…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </label>
      <div className="mt-4 grid gap-5 sm:grid-cols-2" aria-live="polite" data-testid="shortcut-results">
        {groups.length === 0 && <p className="text-sm text-muted">No shortcut matches “{q}”.</p>}
        {groups.map((g) => (
          <section key={g.group} aria-label={g.group}>
            <h3 className="label mb-2">{g.group}</h3>
            <dl className="space-y-1.5">
              {g.items.map((s) => (
                <div key={s.action + s.keys.join()} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="min-w-0">{s.action}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-faint">{g.group === "Anywhere" && s.keys[0] === "G" ? "then" : "/"}</span>}
                        <kbd className="kbd">{k}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Shortcuts are ignored while you type in a text field.</p>
    </Dialog>
  );
}
