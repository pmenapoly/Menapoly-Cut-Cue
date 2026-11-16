// Upload-first (Phase 3): client briefing in the draft Editing Room. The brief autosaves through svc.saveBrief with the
// revision it was based on (409 when another tab saved first), shows what's still missing, then Mark ready → Submit
// editing request (idempotent: key briefId:rev). Submitting freezes the brief as the original instructions; the same
// #video-<id> link then opens the normal Editing Room. Nothing here reaches production work before Submit.
import { h, icon, toast, busy } from "./ui.js";
import { svc } from "./service.js";
import { PLATFORMS, ASPECTS, briefMissing, roomStage } from "./rooms.js";

const PLATFORM_LABELS = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", facebook: "Facebook", x: "X", website: "Website", other: "Other" };
const ASPECT_LABELS = { "16:9": "16:9 landscape", "9:16": "9:16 vertical", "1:1": "1:1 square", "4:5": "4:5 portrait" };
const REQUIRED = [["Title", "title"], ["Desired outcome", "outcome"], ["Editing instructions", "instructions"], ["Platforms or shape", "platforms"]];
const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const refsFrom = (s) => lines(s).slice(0, 10).map((l) => (/^https?:\/\/\S+$/i.test(l) ? { url: l } : { label: l.slice(0, 120) }));
const refsText = (refs) => (refs || []).map((r) => r.url || r.label).join("\n");
const stashKey = (rid) => `cue-brief-unsaved-${svc.me().id}-${rid}`;
const stash = { get(rid) { try { return JSON.parse(sessionStorage.getItem(stashKey(rid)) || "null"); } catch { return null; } },
  set(rid, v) { try { if (v) sessionStorage.setItem(stashKey(rid), JSON.stringify(v)); else sessionStorage.removeItem(stashKey(rid)); } catch { /* storage off: autosave still runs */ } } };

/**
 * Saves changes one at a time, each with the revision it was based on, so two tabs can't silently overwrite each other.
 * Unsaved changes wait in sessionStorage until they're saved, so a reload or a closed tab doesn't lose typing.
 */
function createSaver(rid, startRev, { onSaved, onState, onStale }) {
  let rev = startRev, pending = {}, timer = null, inflight = null;
  const keep = () => stash.set(rid, Object.keys(pending).length ? { rev, patch: pending } : null);
  const run = () => inflight || (inflight = (async () => {
    while (Object.keys(pending).length) {
      const patch = pending; pending = {}; onState("saving");
      try { const b = await svc.saveBrief(rid, patch, rev); rev = b.rev; onSaved(b); }
      catch (e) {
        if (e.code === 409) { pending = {}; keep(); onStale(e); return; }
        pending = { ...patch, ...pending }; keep(); onState("error", e); return; // kept for the next try
      }
    }
    keep(); onState("saved");
  })().finally(() => { inflight = null; }));
  return {
    set(field, value) { pending[field] = value; keep(); onState("pending"); clearTimeout(timer); timer = setTimeout(run, 600); },
    async flush() { clearTimeout(timer); await run(); if (Object.keys(pending).length) await run(); return !Object.keys(pending).length; },
    rev: () => rev, bump(r) { rev = r; },
  };
}

/** The readiness card and the brief form for a draft room. Returns { readiness, form }. */
export function briefPanel(rm, ctx, { onStage } = {}) {
  const rid = rm.id;
  let brief = rm.brief, f = { ...brief.fields };
  // Changes typed before a reload that hadn't saved yet: put them back if the brief hasn't moved on since.
  const left = stash.get(rid), restore = left?.patch && Object.keys(left.patch).length && left.rev === brief.rev ? left.patch : null;
  if (left && !restore) { stash.set(rid, null); if (left.patch && Object.keys(left.patch).length) toast("Some unsaved changes couldn't be restored: the brief changed since.", "err"); }
  if (restore) Object.assign(f, restore);
  const readiness = h("section", { class: "card status-card brief-readiness", "data-tone": "waiting", "aria-label": "Ready to submit?" });
  const saveLine = h("p", { class: "tiny faint", role: "status", "aria-live": "polite", "data-save": "" });

  const saver = createSaver(rid, brief.rev, {
    onSaved(b) { brief = b; f = { ...b.fields }; if (b.fields.title) document.querySelectorAll(".draft-room .room-title").forEach((t) => { t.textContent = b.fields.title; }); drawReadiness(); },
    onState(s, e) {
      saveLine.textContent = s === "saving" ? "Saving…" : s === "pending" ? "Unsaved changes…" : s === "error" ? `Not saved: ${e.message}` : `Saved · revision ${saver.rev()}`;
      saveLine.dataset.save = s;
    },
    onStale() { toast("This brief was changed in another tab. Showing the latest version; your last change wasn't saved.", "err"); ctx.refresh(); },
  });

  function drawReadiness() {
    const missing = briefMissing(f), ready = brief.status === "ready";
    onStage?.(roomStage({}, { brief: { status: brief.status, fields: f }, hasNotes: (rm.instructions || []).length > 0 }));
    readiness.replaceChildren(
      h("span", { class: "eyebrow" }, icon("pen", 14), "Draft · not submitted"),
      h("h2", { class: "status-head" }, ready ? "Ready to submit" : missing.length ? "What should this become?" : "Looks complete"),
      h("p", { class: "small" }, ready ? "Submit it when you're happy. Menapoly then assigns an editor and confirms an estimate."
        : missing.length ? "Fill in the brief below. It saves as you type, so you can leave and come back." : "Everything needed is here. Mark it ready, then submit."),
      h("ul", { class: "readiness", "aria-label": "Brief checklist" },
        REQUIRED.map(([label, key]) => { const ok = !missing.includes(label);
          return h("li", { "data-ok": String(ok) }, h("span", { class: "tick", "aria-hidden": "true" }, ok ? icon("check", 14) : null), h("span", {}, label), h("span", { class: "sr" }, ok ? " (done)" : " (missing)")); }),
        h("li", { "data-ok": String(Boolean(f.requestedDate)), class: "optional" }, h("span", { class: "tick", "aria-hidden": "true" }, f.requestedDate ? icon("check", 14) : null),
          h("span", {}, "When you'd like it (optional)"))),
      ready
        ? h("button", { class: "btn primary", id: "brief-submit", onclick: busy(submit) }, icon("send", 18), "Submit editing request")
        : h("button", { class: "btn primary", id: "brief-ready", disabled: missing.length > 0, onclick: busy(markReady),
            "aria-describedby": missing.length ? `${rid}-missing` : null }, icon("check", 18), "Mark ready to submit"),
      missing.length && !ready ? h("p", { class: "tiny faint", id: `${rid}-missing` }, `Still needed: ${missing.join(", ").toLowerCase()}.`) : null,
      h("p", { class: "tiny faint" }, ready
        ? "Submitting sends the request and freezes these instructions as your original brief. Later changes are added as notes. Tapping twice can't send two requests."
        : "Nothing goes to Menapoly until you submit: no editing request, no editor, no revision rounds used."),
      saveLine);
  }

  async function markReady() {
    if (!(await saver.flush())) return toast("Save your changes first: the brief couldn't be saved.", "err");
    try { brief = await svc.markBriefReady(rid, saver.rev()); saver.bump(brief.rev); drawReadiness(); saveLine.textContent = `Saved · revision ${brief.rev}`; toast("Marked ready. Submit it when you're happy."); }
    catch (e) { toast(e.message, "err"); if (e.code === 409) ctx.refresh(); }
  }
  async function submit() {
    if (!(await saver.flush())) return toast("Save your changes first: the brief couldn't be saved.", "err");
    try {
      await svc.submitBrief(rid, { expectedRev: saver.rev() });
      stash.set(rid, null);
      toast("Editing request sent. Menapoly will assign an editor and confirm an estimate.");
      ctx.refresh(); // the same link now opens the Editing Room
    } catch (e) { toast(e.message, "err"); if (e.code === 409) ctx.refresh(); }
  }

  // ---- the form ----
  const id = (k) => `brief-${k}`;
  const set = (k, v) => { f[k] = v; saver.set(k, v); drawReadiness(); };
  const text = (k, label, { area, rows = 3, hint, placeholder, max } = {}) => h("div", { class: "field" },
    h("label", { for: id(k) }, label), hint ? h("span", { class: "tiny faint", id: `${id(k)}-hint` }, hint) : null,
    // A textarea's text is its content (a value attribute would be ignored), an input's is its value.
    h(area ? "textarea" : "input", { id: id(k), rows: area ? String(rows) : null, maxlength: max ? String(max) : null, placeholder: placeholder || null,
      "aria-describedby": hint ? `${id(k)}-hint` : null, value: area ? null : f[k] || "", oninput: (e) => set(k, e.target.value) }, area ? f[k] || "" : null));
  const listArea = (k, label, hint, toVal, fromVal) => h("div", { class: "field" }, h("label", { for: id(k) }, label), h("span", { class: "tiny faint", id: `${id(k)}-hint` }, hint),
    h("textarea", { id: id(k), rows: "3", "aria-describedby": `${id(k)}-hint`, oninput: (e) => set(k, toVal(e.target.value)) }, fromVal(f[k])));
  const picks = (k, legend, options, labels) => h("fieldset", { class: "picks" }, h("legend", {}, legend),
    h("div", { class: "pick-row" }, options.map((o) => h("label", { class: "pick" },
      h("input", { type: "checkbox", value: o, checked: (f[k] || []).includes(o),
        onchange: (e) => set(k, e.target.checked ? [...new Set([...(f[k] || []), o])] : (f[k] || []).filter((x) => x !== o)) }),
      h("span", {}, labels[o])))));
  const date = h("input", { id: id("requestedDate"), type: "date", value: f.requestedDate || "", "aria-describedby": `${id("requestedDate")}-hint`,
    onchange: (e) => set("requestedDate", e.target.value || null) });

  const form = h("section", { class: "card brief-form", "aria-label": "Your creative brief" },
    h("div", { class: "section-head" }, h("h2", {}, "Your creative brief"), h("span", { class: "tiny faint" }, "Saves as you type")),
    text("title", "Video title", { max: 120 }),
    text("outcome", "What should this video achieve?", { area: true, rows: 2, max: 500, placeholder: "e.g. Bring people to the roastery's opening weekend" }),
    text("instructions", "Editing instructions", { area: true, rows: 5, max: 4000, hint: "What to keep, cut, slow down or add. Mention timestamps if you have them.",
      placeholder: "e.g. Open on the bean pour (0:04). Keep it warm and slow. End on the storefront with the opening date." }),
    picks("platforms", "Where will it run?", PLATFORMS, PLATFORM_LABELS),
    picks("aspects", "Shape", ASPECTS, ASPECT_LABELS),
    h("div", { class: "field" }, h("label", { for: id("requestedDate") }, "When would you like it?"), date,
      h("span", { class: "tiny faint", id: `${id("requestedDate")}-hint` }, "Your request, not a promise. Menapoly confirms an estimate after you submit.")),
    h("details", { class: "brief-more", open: Boolean(f.length || f.brand?.length || f.references?.length || f.music || f.captions || f.visual) || null },
      h("summary", {}, "More details (optional)"),
      text("length", "Length", { max: 40, placeholder: "e.g. 30 seconds" }),
      listArea("brand", "Brand notes", "One per line, e.g. logo for the last 2 seconds.", lines, (v) => (v || []).join("\n")),
      listArea("references", "References", "One per line: a web link or a short description.", refsFrom, refsText),
      text("visual", "Look and pacing", { area: true, rows: 2, max: 1000 }),
      text("music", "Music and sound", { area: true, rows: 2, max: 500 }),
      text("captions", "Captions", { area: true, rows: 2, max: 500 })),
    h("p", { class: "tiny faint" }, "Drawing on frames and voice notes come in a later update of this preview."));

  if (restore) { Object.entries(restore).forEach(([k, v]) => saver.set(k, v)); toast("Restored changes that weren't saved yet."); }
  // Leaving the room (another page, closing the tab): send what's waiting.
  const leave = () => { saver.flush(); };
  addEventListener("hashchange", leave, { once: true });
  addEventListener("pagehide", leave, { once: true });
  drawReadiness();
  saveLine.textContent = restore ? "Unsaved changes…" : brief.rev ? `Saved · revision ${brief.rev}` : "Not started yet";
  return { readiness, form };
}
