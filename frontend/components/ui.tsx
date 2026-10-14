"use client";
// Reusable, accessible UI primitives for Menapoly Cut Cue.
import { ReactNode, useEffect, useId, useRef } from "react";

const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2",
  play: "M8 5.5v13l11-6.5z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  back5: "M11 7L6 12l5 5M18 7l-5 5 5 5",
  fwd5: "M13 7l5 5-5 5M6 7l5 5-5 5",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3",
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M6 6l12 12M18 6L6 18",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  download: "M12 4v12m0 0l-4-4m4 4l4-4M4 18v1a1 1 0 001 1h14a1 1 0 001-1v-1",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  scissors: "M6 6a2 2 0 100 .01M6 18a2 2 0 100 .01M8 7.5L20 18M8 16.5L20 6",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  history: "M3 12a9 9 0 103-6.7M3 4v5h5M12 8v4l3 2",
  compare: "M12 3v18M5 7h4v10H5zM15 7h4v10h-4z",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  chat: "M4 5h16v11H9l-5 4z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  keyboard: "M3 7h18v10H3zM7 11h0M11 11h0M15 11h0M7 14h10",
  chevron: "M9 6l6 6-6 6",
  info: "M12 8h0M11 12h1v5h1M12 22a10 10 0 110-20 10 10 0 010 20z",
  arrowLeft: "M15 6l-6 6 6 6",
  maximize: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  volume: "M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6",
  music: "M9 18V6l11-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z",
  wand: "M4 20L15 9M14 4l1.5 3L19 8.5 15.5 10 14 13l-1.5-3L9 8.5 12.5 7z",
};

export function Icon({ name, size = 18, className = "", label }: { name: keyof typeof PATHS | string; size?: number; className?: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={name === "play" ? "currentColor" : "none"} stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}
         role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Progress({ value, label, tone = "accent" }: { value: number; label: string; tone?: "accent" | "ok" | "danger" }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = tone === "ok" ? "bg-ok" : tone === "danger" ? "bg-danger" : "bg-gradient-to-r from-accent-strong to-violet";
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
         className="h-1.5 w-full overflow-hidden rounded-full bg-panel3">
      <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Dialog({ open, onClose, title, children, wide = false }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    (focusables()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm animate-fade-in sm:items-center sm:p-6"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
           className={`card max-h-[92dvh] w-full overflow-y-auto rounded-b-none p-5 animate-rise sm:rounded-2xl ${wide ? "sm:max-w-4xl" : "sm:max-w-lg"}`}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label, size = "md" }: {
  tabs: { id: T; label: string; icon?: string; badge?: number }[]; value: T; onChange: (t: T) => void; label: string; size?: "sm" | "md";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto rounded-xl bg-panel2 p-1 scroll-thin">
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" aria-selected={value === t.id}
                tabIndex={value === t.id ? 0 : -1} id={`tab-${t.id}`}
                onKeyDown={(e) => {
                  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                  if (!d) return;
                  const next = (i + d + tabs.length) % tabs.length;
                  onChange(tabs[next].id); refs.current[next]?.focus();
                }}
                onClick={() => onChange(t.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition-colors ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${
                  value === t.id ? "bg-panel3 text-text shadow-sm" : "text-muted hover:text-text"}`}>
          {t.icon && <Icon name={t.icon} size={15} />}{t.label}
          {!!t.badge && <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-violet"><Icon name={icon} size={22} /></div>
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Toasts({ toasts }: { toasts: { id: number; text: string; tone: "ok" | "error" | "info" }[] }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === "error" ? "alert" : "status"}
             className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-2xl animate-rise ${
               t.tone === "error" ? "border-danger/40 bg-[#2a1520] text-[#ffd5da]" : t.tone === "ok" ? "border-ok/30 bg-[#11241c] text-[#cdf5e2]" : "border-line2 bg-panel3"}`}>
          <Icon name={t.tone === "error" ? "info" : "check"} size={16} className="mt-0.5 shrink-0" />{t.text}
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-xl border border-line bg-panel2 p-0.5">
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} title={o.hint} onClick={() => onChange(o.id)}
                className={`rounded-[10px] px-3 py-1.5 text-sm font-medium transition-all ${
                  value === o.id ? "bg-gradient-to-br from-accent-strong to-[#9a6cf5] text-white shadow" : "text-muted hover:text-text"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-accent-strong to-violet text-white shadow-[0_6px_20px_-6px_#7262f2]">
        <Icon name="scissors" size={17} />
      </span>
      {!compact && <span className="text-[15px] font-semibold tracking-tight">Menapoly <span className="text-violet">Cut Cue</span></span>}
    </span>
  );
}
