"use client";
// LIBRARY: media across projects (deduplicated), briefs, brand kits, templates and export presets.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AppShell, { useShell } from "@/components/shell";
import { Dialog, Empty, ErrorState, Icon, Loading, Tabs } from "@/components/ui";
import { api, ApiError, fmtBytes, thumbUrl } from "@/lib/api";
import { Library, LibraryItem } from "@/lib/cue";
import { duration, timeAgo } from "@/lib/format";

const TABS = [
  { id: "media", label: "Media" }, { id: "brand", label: "Brand kits" }, { id: "briefs", label: "Briefs" },
  { id: "templates", label: "Templates" },
] as const;

function BrandKitDialog({ item, open, onClose, onSaved }: { item: LibraryItem | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useShell();
  const d = (item?.data ?? {}) as { colors?: string[]; fonts?: string[]; voice?: string; dos?: string; donts?: string };
  const [name, setName] = useState("");
  const [colors, setColors] = useState("");
  const [fonts, setFonts] = useState("");
  const [voice, setVoice] = useState("");
  const [donts, setDonts] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? ""); setColors((d.colors ?? []).join(", ")); setFonts((d.fonts ?? []).join(", "));
    setVoice(d.voice ?? ""); setDonts(d.donts ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onClose={onClose} title={item ? "Edit brand kit" : "New brand kit"}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const body = { kind: "brand_kit", name, data: { colors: colors.split(/[\s,]+/).filter(Boolean), fonts: fonts.split(",").map((f) => f.trim()).filter(Boolean), voice, donts } };
        try {
          if (item) await api.put(`/cue/library/${item.id}`, body); else await api.post("/cue/library", body);
          toast("Brand kit saved"); onSaved(); onClose();
        } catch (err) { toast(err instanceof ApiError ? err.message : "Couldn't save", "error"); }
      }}>
        <label className="block space-y-1"><span className="label">Name</span><input className="input min-h-11" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="block space-y-1"><span className="label">Colors (hex, e.g. #8B79F7)</span><input className="input min-h-11 font-mono" value={colors} onChange={(e) => setColors(e.target.value)} /></label>
        <label className="block space-y-1"><span className="label">Fonts</span><input className="input min-h-11" value={fonts} onChange={(e) => setFonts(e.target.value)} /></label>
        <label className="block space-y-1"><span className="label">Voice and tone</span><textarea className="input" rows={2} value={voice} onChange={(e) => setVoice(e.target.value)} /></label>
        <label className="block space-y-1"><span className="label">Avoid</span><textarea className="input" rows={2} value={donts} onChange={(e) => setDonts(e.target.value)} /></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()}>Save</button></div>
      </form>
    </Dialog>
  );
}

function TemplateDialog({ open, onClose, onSaved, presets }: { open: boolean; onClose: () => void; onSaved: () => void; presets: Library["presets"] }) {
  const { toast } = useShell();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("");
  const [prompt, setPrompt] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="New template">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post("/cue/library", { kind: "template", name, data: { preset: preset || null, prompt } }); toast("Template saved"); onSaved(); onClose(); setName(""); setPrompt(""); }
        catch (err) { toast(err instanceof ApiError ? err.message : "Couldn't save", "error"); }
      }}>
        <label className="block space-y-1"><span className="label">Name</span><input className="input min-h-11" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Weekly podcast" /></label>
        <label className="block space-y-1"><span className="label">Export preset</span>
          <select className="input min-h-11" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">None</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select></label>
        <label className="block space-y-1"><span className="label">What to ask Cue</span><textarea className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Tighten pauses, add a hook, 3 vertical clips with captions" /></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()}>Save</button></div>
      </form>
    </Dialog>
  );
}

function LibraryPage() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useShell();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "media") as (typeof TABS)[number]["id"];
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<LibraryItem | null | "new">(null);
  const [newTpl, setNewTpl] = useState(false);
  const load = useCallback(() => api.get<Library>(`/cue/library?q=${encodeURIComponent(q)}`).then((l) => { setLib(l); setError(false); }).catch(() => setError(true)), [q]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  const remove = async (it: LibraryItem) => {
    if (!confirm(`Delete “${it.name}”?`)) return;
    await api.del(`/cue/library/${it.id}`); toast("Deleted"); load();
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Search the library</span>
          <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input min-h-11 pl-9" placeholder="Search files, briefs, kits" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {tab === "brand" && <button className="btn btn-primary min-h-11" onClick={() => setEditing("new")}><Icon name="plus" /> Brand kit</button>}
        {tab === "templates" && <button className="btn btn-primary min-h-11" onClick={() => setNewTpl(true)}><Icon name="plus" /> Template</button>}
      </div>
      <Tabs label="Library sections" value={tab} onChange={(t) => router.replace(`/library/?tab=${t}`, { scroll: false })} tabs={[...TABS]} />
      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {error ? <ErrorState title="Couldn't load the library" onRetry={load} /> : !lib ? <Loading /> : (
          <>
            {tab === "media" && (lib.media.length === 0 ? <Empty icon="film" title="No media yet">Files you upload to any project show up here.</Empty> : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Media">
                {lib.media.map((m) => (
                  <li key={m.id}><Link href={`/projects/?id=${m.project_id}&tab=media`} className="flex gap-3 rounded-xl border border-line bg-panel p-2 hover:border-line2">
                    <span className="grid h-14 w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-panel2 text-faint">
                      {m.thumb_name ? <img src={thumbUrl(m.project_id, m.id)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Icon name={m.kind === "audio" ? "wave" : "film"} />}
                    </span>
                    <span className="min-w-0 text-sm"><span className="block truncate font-medium">{m.original_name}</span>
                      <span className="block truncate text-xs text-muted">{m.project_name}{m.also_in?.length ? ` + ${m.also_in.length} more (stored once)` : ""}</span>
                      <span className="block text-xs text-faint">{m.duration ? duration(m.duration) + " · " : ""}{fmtBytes(m.size)}</span></span>
                  </Link></li>
                ))}
              </ul>
            ))}
            {tab === "briefs" && (lib.briefs.length === 0 ? <Empty icon="doc" title="No briefs yet">Briefs uploaded to projects show up here.</Empty> : (
              <ul className="card divide-y divide-line/60 p-1" aria-label="Briefs">
                {lib.briefs.map((b) => (
                  <li key={b.id}><Link href={`/projects/?id=${b.project_id}&tab=brief`} className="flex min-h-14 items-center gap-3 p-2 hover:bg-panel2">
                    <Icon name="doc" className="text-muted" />
                    <span className="min-w-0 flex-1 text-sm"><span className="block truncate font-medium">{b.original_name}</span>
                      <span className="block truncate text-xs text-muted">{b.project_name}{b.client ? ` · ${b.client}` : ""} · {b.deliverables} deliverable{b.deliverables === 1 ? "" : "s"} · {timeAgo(b.created_at)}</span></span>
                  </Link></li>
                ))}
              </ul>
            ))}
            {tab === "brand" && (lib.brand_kits.length === 0 ? <Empty icon="palette" title="No brand kits yet">Save a client&apos;s colors, fonts and tone in one place.</Empty> : (
              <ul className="grid gap-3 sm:grid-cols-2" aria-label="Brand kits">
                {lib.brand_kits.map((k) => {
                  const d = k.data as { colors?: string[]; fonts?: string[]; voice?: string };
                  return (
                    <li key={k.id} className="card p-4">
                      <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{k.name}</h3>
                        <span className="flex gap-1"><button className="btn btn-sm" onClick={() => setEditing(k)}>Edit</button>
                          <button className="btn btn-ghost btn-sm" aria-label={`Delete ${k.name}`} onClick={() => remove(k)}><Icon name="trash" size={14} /></button></span></div>
                      <div className="mt-2 flex flex-wrap gap-1.5">{(d.colors ?? []).map((c) => <span key={c} className="flex items-center gap-1 text-xs"><span className="h-5 w-5 rounded-md border border-line" style={{ background: c }} />{c}</span>)}</div>
                      {!!d.fonts?.length && <p className="mt-2 text-xs text-muted">Fonts: {d.fonts.join(", ")}</p>}
                      {d.voice && <p className="mt-1 text-sm">{d.voice}</p>}
                    </li>
                  );
                })}
              </ul>
            ))}
            {tab === "templates" && (
              <div className="space-y-4">
                {lib.templates.length === 0 ? <Empty icon="template" title="No templates yet">Save what you usually ask Cue for, with an export preset.</Empty> : (
                  <ul className="grid gap-3 sm:grid-cols-2" aria-label="Templates">
                    {lib.templates.map((t) => {
                      const d = t.data as { preset?: string; prompt?: string };
                      return <li key={t.id} className="card p-4"><div className="flex justify-between gap-2"><h3 className="font-semibold">{t.name}</h3>
                        <button className="btn btn-ghost btn-sm" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}><Icon name="trash" size={14} /></button></div>
                        {d.preset && <p className="text-xs text-muted">Export: {lib.presets.find((p) => p.id === d.preset)?.label ?? d.preset}</p>}
                        {d.prompt && <p className="mt-1 text-sm">“{d.prompt}”</p>}</li>;
                    })}
                  </ul>
                )}
                <section><h2 className="mb-2 text-sm font-semibold text-muted">Built-in export presets</h2>
                  <ul className="grid gap-2 sm:grid-cols-2">{lib.presets.map((p) => <li key={p.id} className="rounded-xl border border-line bg-panel p-3 text-sm"><span className="font-medium">{p.label}</span><span className="block text-xs text-muted">{p.description}</span></li>)}</ul>
                </section>
              </div>
            )}
          </>
        )}
      </div>
      <BrandKitDialog item={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onSaved={load} />
      {lib && <TemplateDialog open={newTpl} onClose={() => setNewTpl(false)} onSaved={load} presets={lib.presets} />}
    </div>
  );
}

export default function Page() {
  return <AppShell title="Library"><Suspense fallback={null}><LibraryPage /></Suspense></AppShell>;
}
