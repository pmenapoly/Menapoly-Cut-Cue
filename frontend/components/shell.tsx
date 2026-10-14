"use client";
// Menapoly Cue app shell: five destinations (Home, Projects, Cut Cue, Inbox, Library) + Settings.
// Phones: top bar + bottom tab bar. Tablets: icon rail. Desktops (≥1280px): labelled sidebar.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Notification } from "@/lib/cue";
import { timeAgo } from "@/lib/format";
import { isTypingTarget } from "@/lib/shortcuts";
import AuthGate from "./AuthGate";
import ShortcutsDialog from "./ShortcutsDialog";
import { Dialog, Empty, Icon, Logo, Spinner, Toasts } from "./ui";

export const NAV = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/projects/", label: "Projects", icon: "folder" },
  { href: "/cut/", label: "Cut Cue", icon: "scissors" },
  { href: "/inbox/", label: "Inbox", icon: "inbox" },
  { href: "/library/", label: "Library", icon: "library" },
] as const;

type Toast = { id: number; text: string; tone: "ok" | "error" | "info" };
type ShellCtx = { toast: (text: string, tone?: Toast["tone"]) => void; refreshBadges: () => void; unread: number; pending: number };
const Ctx = createContext<ShellCtx>({ toast: () => {}, refreshBadges: () => {}, unread: 0, pending: 0 });
export const useShell = () => useContext(Ctx);

// --- theme -------------------------------------------------------------------------------------------
export type ThemePref = "system" | "light" | "dark";
export function applyTheme(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === "system") delete el.dataset.theme; else el.dataset.theme = pref;
  try { localStorage.setItem("cue-theme", pref); } catch { /* private mode */ }
}
export function readTheme(): ThemePref {
  try { return (localStorage.getItem("cue-theme") as ThemePref) || "system"; } catch { return "system"; }
}

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => setPref(readTheme()), []);
  const next: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
  const label = { system: "Theme: match device", light: "Theme: light", dark: "Theme: dark" }[pref];
  return (
    <button className={`btn btn-ghost ${withLabel ? "w-full justify-start" : "btn-icon"}`} aria-label={label} title={label}
            onClick={() => { const p = next[pref]; setPref(p); applyTheme(p); }}>
      <Icon name={pref === "dark" ? "moon" : pref === "light" ? "sun" : "monitor"} />
      {withLabel && <span className="text-sm">{label.replace("Theme: ", "Theme · ")}</span>}
    </button>
  );
}

// --- notification center -------------------------------------------------------------------------------
function NotificationCenter({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (before?: number) => {
    try {
      const r = await api.get<{ items: Notification[]; next_before: number | null }>(`/cue/notifications?limit=20${before ? `&before=${before}` : ""}`);
      setItems((prev) => (before && prev ? [...prev, ...r.items] : r.items));
      setNext(r.next_before);
      setError(false);
    } catch { setError(true); }
  }, []);
  useEffect(() => { if (open) { setItems(null); load(); } }, [open, load]);
  const go = async (n: Notification) => {
    if (!n.read_at) { await api.post(`/cue/notifications/${n.id}/read`).catch(() => {}); onChanged(); }
    onClose();
    if (n.href) router.push(n.href);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Notifications">
      <div className="mb-3 flex justify-end">
        <button className="btn btn-sm" onClick={async () => { await api.post("/cue/notifications/read"); onChanged(); load(); }}>
          <Icon name="check" size={14} /> Mark all read
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-danger">Couldn&apos;t load notifications. Check that Cue is running.</p>
        : items === null ? <div className="grid place-items-center py-8"><Spinner /></div>
        : items.length === 0 ? <Empty icon="bell" title="You're all caught up">Finished renders, client notes and texts show up here.</Empty>
        : (
          <ul className="-mx-2 space-y-1" aria-label="Notifications list">
            {items.map((n) => (
              <li key={n.id}>
                <button onClick={() => go(n)} className="flex w-full gap-3 rounded-xl p-2.5 text-left hover:bg-panel2">
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${n.read_at ? "text-muted" : "font-medium"}`}>{n.title}{!n.read_at && <span className="sr-only"> (unread)</span>}</span>
                    {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                    <span className="block text-xs text-faint">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {next && <button className="btn btn-sm mt-3 w-full" onClick={() => load(next)}>Load more</button>}
    </Dialog>
  );
}

// --- global search -------------------------------------------------------------------------------------
type SearchResult = {
  projects: { id: string; name: string; client_name: string | null; status: { label: string } }[];
  moments: { project_id: string; project_name: string; original_name: string; start: number; text: string }[];
  media: { id: string; project_id: string; project_name: string; original_name: string }[];
};
function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const t = setTimeout(async () => {
      setBusy(true);
      try { setRes(await api.get<SearchResult>(`/cue/search?q=${encodeURIComponent(q)}`)); } catch { setRes(null); }
      setBusy(false);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  const total = res ? res.projects.length + res.moments.length + res.media.length : 0;
  return (
    <Dialog open={open} onClose={onClose} title="Search">
      <label className="block">
        <span className="sr-only">Search projects, clients, files and spoken words</span>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Projects, clients, files, or something someone said" autoFocus />
      </label>
      <div className="mt-3 min-h-16" aria-live="polite">
        {busy && <Spinner />}
        {res && total === 0 && !busy && <p className="text-sm text-muted">Nothing found for “{q}”.</p>}
        {res && total > 0 && (
          <div className="space-y-4">
            {!!res.projects.length && <section><h3 className="label mb-1">Projects</h3><ul>
              {res.projects.map((p) => <li key={p.id}><Link onClick={onClose} href={`/projects/?id=${p.id}`} className="flex justify-between gap-2 rounded-lg p-2 text-sm hover:bg-panel2">
                <span className="truncate">{p.name}{p.client_name && <span className="text-muted"> · {p.client_name}</span>}</span><span className="shrink-0 text-xs text-muted">{p.status.label}</span></Link></li>)}
            </ul></section>}
            {!!res.moments.length && <section><h3 className="label mb-1">Spoken</h3><ul>
              {res.moments.map((m, i) => <li key={i}><Link onClick={onClose} href={`/project/?id=${m.project_id}&mode=simple`} className="block rounded-lg p-2 text-sm hover:bg-panel2">
                <span className="line-clamp-2">“{m.text}”</span><span className="text-xs text-muted">{m.project_name} · {m.original_name} at {Math.floor(m.start / 60)}:{String(Math.floor(m.start % 60)).padStart(2, "0")}</span></Link></li>)}
            </ul></section>}
            {!!res.media.length && <section><h3 className="label mb-1">Files</h3><ul>
              {res.media.map((m) => <li key={m.id}><Link onClick={onClose} href={`/projects/?id=${m.project_id}&tab=media`} className="block truncate rounded-lg p-2 text-sm hover:bg-panel2">
                {m.original_name} <span className="text-muted">· {m.project_name}</span></Link></li>)}
            </ul></section>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// --- shell -------------------------------------------------------------------------------------------
function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href.replace(/\/$/, ""));
}

function Shell({ children, title }: { children: ReactNode; title: string }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const seq = useRef(0);
  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);
  const refreshBadges = useCallback(() => {
    api.get<{ unread: number }>("/cue/notifications?limit=1").then((r) => setUnread(r.unread)).catch(() => {});
    api.get<unknown[]>("/cue/actions?status=proposed").then((r) => setPending(r.length)).catch(() => {});
  }, []);
  useEffect(() => {
    refreshBadges();
    const t = setInterval(refreshBadges, 15000);
    return () => clearInterval(t);
  }, [refreshBadges]);
  useEffect(() => {
    let pendingG = 0;
    const GO: Record<string, string> = { h: "/", p: "/projects/", c: "/cut/", i: "/inbox/", l: "/library/" };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === "?") { e.preventDefault(); setHelpOpen(true); return; }
      const k = e.key.toLowerCase();
      if (pendingG && Date.now() - pendingG < 1200 && GO[k]) { e.preventDefault(); pendingG = 0; router.push(GO[k]); return; }
      pendingG = k === "g" ? Date.now() : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const badge = (href: string) => (href === "/inbox/" ? pending : 0);

  return (
    <Ctx.Provider value={{ toast, refreshBadges, unread, pending }}>
      <div className="min-h-dvh md:pl-[84px] xl:pl-60">
        {/* Rail / sidebar (tablet and up) */}
        <nav aria-label="Main" className="fixed inset-y-0 left-0 z-40 hidden w-[84px] flex-col border-r border-line bg-panel/95 px-2 py-4 backdrop-blur md:flex xl:w-60 xl:px-3">
          <Link href="/" className="mb-6 flex justify-center rounded-xl p-1 xl:justify-start" aria-label="Menapoly Cue home">
            <span className="xl:hidden"><Logo compact product="cue" /></span>
            <span className="hidden xl:inline"><Logo product="cue" /></span>
          </Link>
          <ul className="space-y-1">
            {NAV.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={active ? "page" : undefined}
                        className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] font-medium transition-colors xl:flex-row xl:justify-start xl:gap-3 xl:px-3 xl:text-sm ${
                          active ? "bg-accent-soft text-text" : "text-muted hover:bg-panel2 hover:text-text"}`}>
                    <Icon name={n.icon} size={20} className={active ? "text-violet" : ""} />{n.label}
                    {!!badge(n.href) && <span className="absolute right-2 top-1.5 min-w-5 rounded-full bg-accent-strong px-1 text-center text-[10px] font-semibold text-on-accent xl:static xl:ml-auto"
                                              aria-label={`${badge(n.href)} waiting`}>{badge(n.href)}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto space-y-1">
            <Link href="/settings/" aria-current={isActive(pathname, "/settings/") ? "page" : undefined}
                  className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] font-medium xl:flex-row xl:justify-start xl:gap-3 xl:px-3 xl:text-sm ${
                    isActive(pathname, "/settings/") ? "bg-accent-soft text-text" : "text-muted hover:bg-panel2 hover:text-text"}`}>
              <Icon name="settings" size={20} />Settings
            </Link>
          </div>
        </nav>

        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-ink/85 px-4 backdrop-blur sm:px-6">
          <Link href="/" className="-ml-1.5 grid h-11 w-11 shrink-0 place-items-center md:hidden" aria-label="Menapoly Cue home"><Logo compact product="cue" /></Link>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight sm:text-lg">{title}</h1>
          <button className="btn btn-ghost btn-icon" aria-label="Search (⌘K)" title="Search (⌘K)" onClick={() => setSearchOpen(true)}><Icon name="search" /></button>
          <button className="btn btn-ghost btn-icon relative" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
                  onClick={() => setNotesOpen(true)} data-testid="bell">
            <Icon name="bell" />
            {!!unread && <span aria-hidden className="absolute right-1 top-1 min-w-4 rounded-full bg-accent-strong px-1 text-[10px] font-semibold leading-4 text-on-accent">{unread > 9 ? "9+" : unread}</span>}
          </button>
          <button className="btn btn-ghost btn-icon hidden md:inline-flex" aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)"
                  onClick={() => setHelpOpen(true)}><Icon name="keyboard" /></button>
          <span className="hidden sm:inline-flex"><ThemeToggle /></span>
          <Link href="/settings/" className="btn btn-ghost btn-icon md:hidden" aria-label="Settings"><Icon name="settings" /></Link>
        </header>

        <main id="main" className="mx-auto w-full max-w-7xl px-4 pb-28 pt-5 sm:px-6 md:pb-12">{children}</main>

        {/* Bottom tab bar (phones) */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          <ul className="grid grid-cols-5">
            {NAV.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={active ? "page" : undefined}
                        className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? "text-text" : "text-muted"}`}>
                    <Icon name={n.icon} size={21} className={active ? "text-violet" : ""} />{n.label}
                    {!!badge(n.href) && <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-accent-strong px-1 text-center text-[10px] font-semibold leading-4 text-on-accent"
                                              aria-label={`${badge(n.href)} waiting`}>{badge(n.href)}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <NotificationCenter open={notesOpen} onClose={() => setNotesOpen(false)} onChanged={refreshBadges} />
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toasts toasts={toasts} />
    </Ctx.Provider>
  );
}

export default function AppShell({ children, title }: { children: ReactNode; title: string }) {
  return <AuthGate><Shell title={title}>{children}</Shell></AuthGate>;
}

/** Card section with a heading row; used across shell pages. */
export function Section({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  const hid = `${id ?? title.toLowerCase().replace(/\W+/g, "-")}-h`;
  return (
    <section aria-labelledby={hid} className="min-w-0">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 id={hid} className="text-sm font-semibold tracking-tight text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
