// Social Sharing, AI Visibility, Ask Cue, Coaching, Clients, Team and Settings.
import { h, icon, toast, sheet, empty, ago, avatar, statusTone, demoBadge, fictional, busy, lineChart, barChart, donut, PALETTE, copyText, fmtDate } from "./ui.js";
import { svc } from "./service.js";
import { PLATFORMS } from "./data.js";
import { PLANS } from "./policy.js";
import { active as assistant } from "./assistant.js";
import { composer, wsPicker } from "./views-home.js";

const mem = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } return v; };

/* ================= Social Sharing ================= */
/** From finished video to prepared post, with honest labels: drafts are drafts and nothing is published. */
export function pipelineStrip(p) {
  const step = (n, label, sub, tone, link) => h(link ? "a" : "div", { class: "pipe-step", "data-tone": tone, href: link ? `#${link}` : null },
    h("b", {}, String(n)), h("span", {}, label), sub ? h("small", {}, sub) : null);
  return h("section", { class: "pipeline", "aria-label": "Content pipeline" },
    step(p.inProduction, "In production", "being made or reviewed", "editing", "studio"),
    step(p.approved, "Approved videos", "finished and signed off", "done", "review"),
    step(p.repurposable, "Ready to reuse", `of ${p.shareable} in the sharing library`, "waiting", "library"),
    step(p.drafts + p.awaiting, "Post drafts", `${p.awaiting} waiting for approval`, "review"),
    step(p.approvedPosts + p.ready, "Prepared posts", `${p.ready} marked ready to schedule (simulated)`, "done"),
    step(p.published, "Published", "publishing isn't connected in the preview", "changes"));
}

export async function socialView(out, _p, ctx) {
  const me = svc.me(), ws = svc.currentWs();
  const tab = mem("cue-social-tab") || "drafts";
  const [posts, approved, pipe] = await Promise.all([svc.posts(ws?.id), svc.assets({ ws: ws?.id, channel: true }), svc.pipeline(ws?.id)]);
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, ws?.name || ""), h("h1", {}, "Social Sharing")),
      h("div", { class: "row" }, wsPicker(() => ctx.rerenderShell()), h("button", { class: "btn primary", onclick: () => composer(ws, ctx) }, icon("pen", 18), "Draft a post"))),
    h("p", { class: "small" }, demoBadge("Preparation only"), " Captions, approvals and calendars work here. No account is connected and nothing is posted."),
    pipelineStrip(pipe),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Social" }, [["drafts", "Posts"], ["calendar", "Calendar"], ["ideas", "Reuse ideas"]].map(([k, l]) =>
      h("button", { class: "tab", role: "tab", "aria-selected": String(tab === k), onclick: () => { mem("cue-social-tab", k); ctx.refresh(); } }, l))));
  if (tab === "calendar") { out.append(calendar(posts)); return; }
  if (tab === "ideas") {
    const unused = approved.filter((a) => !posts.some((p) => p.assetId === a.id));
    out.append(unused.length ? h("div", { class: "grid-2" }, unused.map((a) => h("div", { class: "card" }, h("b", {}, a.name),
      h("p", { class: "small muted" }, a.kind === "video" ? "Cut three 20-second verticals, pull one quote card, and write a LinkedIn post about the story behind it." : "Use it in a carousel with two related stills."),
      h("button", { class: "btn", onclick: () => composer(ws, ctx, { assetId: a.id }) }, "Draft from this"))))
      : empty("Everything approved has a post", "New approvals will show up here as ideas."));
    return;
  }
  out.append(posts.length ? h("div", { class: "stack", style: "gap:14px" }, posts.map((p) => postCard(p, me, ctx)))
    : empty("No posts yet", approved.length ? "Draft one from your approved media." : "Approve a deliverable in Review first.", h("button", { class: "btn primary", onclick: () => composer(ws, ctx) }, "Draft a post")));
}

const POST_TONE = { Draft: "waiting", Submitted: "review", "Changes requested": "changes", Approved: "done", "Prepared for publishing": "editing" };
/** One social post through review: Draft → Submitted → Changes requested or Approved → Prepared for publishing (simulated). */
function postCard(p, me, ctx) {
  let current = p.platforms[0];
  const editable = !/prepared/i.test(p.status) && me.role !== "editor";
  const box = h("div", { class: "stack" });
  const drawEditor = () => {
    const limit = PLATFORMS.find((x) => x.id === current)?.limit || 2200;
    const ta = h("textarea", { id: `cap-${p.id}-${current}`, maxlength: String(limit), "aria-label": `${current} caption`, readonly: !editable }, p.captions[current] || "");
    const count = h("span", { class: "hint" }, `${ta.value.length} / ${limit}`);
    ta.addEventListener("input", () => { count.textContent = `${ta.value.length} / ${limit}`; p.captions[current] = ta.value; });
    box.replaceChildren(...[
      h("div", { class: "tabs", role: "tablist", "aria-label": "Channel captions" }, p.platforms.map((pl) => h("button", { class: "tab", role: "tab", "aria-selected": String(pl === current),
        onclick: () => { current = pl; drawEditor(); } }, PLATFORMS.find((x) => x.id === pl)?.label || pl))),
      ta, count,
      /submitted|approved/i.test(p.status) && editable ? h("p", { class: "tiny faint" }, "Saving a change sends this post back to Draft; it needs review again.") : null,
      h("div", { class: "actions" },
        h("button", { class: "btn sm", onclick: () => copyText(ta.value, ta) }, icon("copy", 16), "Copy caption"),
        h("button", { class: "btn sm", onclick: () => copyText(`${p.asset.name} (approved in Menapoly Cue)`) }, icon("copy", 16), "Copy media reference"),
        editable ? h("button", { class: "btn sm", onclick: busy(async () => { try { await svc.savePost({ id: p.id, assetId: p.assetId, platforms: p.platforms, captions: p.captions, scheduledFor: p.scheduledFor });
          toast(/submitted|approved/i.test(p.status) ? "Saved. Back to Draft: submit it for review again." : "Captions saved"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } }) }, "Save") : null)].filter(Boolean));
  };
  drawEditor();
  const run = (fn, ok) => busy(async () => { try { await fn(); toast(ok); ctx.refresh(); } catch (e) { toast(e.message, "err"); if (e.code === 409) ctx.refresh(); } });
  const note = h("textarea", { id: `rv-note-${p.id}`, placeholder: "What should change in the caption or the choice of media?", maxlength: "1000" });
  const changesForm = h("div", { class: "stack", hidden: true }, h("label", { for: `rv-note-${p.id}` }, "What should change?"), note,
    h("button", { class: "btn primary", style: "justify-self:start", onclick: run(() => svc.reviewPost(p.id, "changes", note.value, p.rev), "Changes requested. The author has been told.") }, "Send to the author"));
  const lastChange = [...p.history].reverse().find((x) => x.action === "Requested changes");
  const step = {
    Draft: me.role !== "editor" ? h("button", { class: "btn primary", onclick: run(() => svc.submitPost(p.id, p.rev), p.rev > 1 ? "Resubmitted for review" : "Submitted for review") }, icon("send", 18), p.rev > 1 ? "Resubmit for review" : "Submit for review") : null,
    "Changes requested": me.role !== "editor" ? h("button", { class: "btn primary", onclick: run(() => svc.submitPost(p.id, p.rev), "Resubmitted for review") }, icon("send", 18), "Resubmit for review") : null,
    Submitted: p.canReview ? [h("button", { class: "btn primary", onclick: run(() => svc.reviewPost(p.id, "approve", "", p.rev), "Post approved (not published)") }, icon("check", 18), "Approve"),
      h("button", { class: "btn", onclick: () => { changesForm.hidden = !changesForm.hidden; if (!changesForm.hidden) note.focus(); } }, icon("message", 18), "Request changes")]
      : h("p", { class: "small muted" }, p.submittedBy === me.id ? "Waiting for a reviewer. You submitted it, so someone else approves it." : "Waiting for a reviewer."),
    Approved: me.role === "admin" ? h("button", { class: "btn primary", onclick: run(() => svc.schedulePost(p.id), "Prepared for publishing (simulated, nothing posted)") }, icon("calendar", 18), "Prepare for publishing")
      : h("p", { class: "small muted" }, "Approved. A Menapoly producer prepares it for publishing."),
    "Prepared for publishing": h("p", { class: "small" }, demoBadge("Simulated"), " Prepared for publishing. Not published: no social account is connected in the preview."),
  }[p.status];
  return h("article", { class: "card", "data-post": p.id },
    h("div", { class: "row nowrap" }, h("span", { class: "thumb", style: "width:72px;height:72px" }, p.asset?.mediaInfo?.poster ? h("img", { src: p.asset.mediaInfo.poster, alt: "" }) : icon("film")),
      h("div", { class: "stack", style: "gap:2px;min-width:0" }, h("b", { style: "overflow-wrap:anywhere" }, p.asset?.name), h("span", { class: "small faint" }, `${p.platforms.length} channel(s) · planned ${p.scheduledFor ? fmtDate(p.scheduledFor) : "—"} · revision ${p.rev}`),
        h("span", {}, h("span", { class: "status", "data-tone": POST_TONE[p.status] || "waiting" }, p.status)))),
    h("dl", { class: "post-roles" },
      h("div", {}, h("dt", {}, "Owner"), h("dd", {}, p.owner)), h("div", {}, h("dt", {}, "Created by"), h("dd", {}, p.byName)),
      h("div", {}, h("dt", {}, "Submitted by"), h("dd", {}, p.submittedByName || "Not yet")), h("div", {}, h("dt", {}, "Reviewer"), h("dd", {}, p.reviewerName || "Not reviewed yet"))),
    p.status === "Changes requested" && lastChange ? h("p", { class: "post-feedback" }, h("b", {}, `${lastChange.byName} asked for changes: `), lastChange.note) : null,
    box,
    h("div", { class: "actions" }, step,
      h("button", { class: "btn ghost sm", disabled: true, title: "Downloads are off in the preview" }, icon("download", 16), "Download (off in preview)")),
    changesForm,
    p.history.length ? h("details", {}, h("summary", { class: "small audit-toggle" }, `Approval history (${p.history.length})`),
      h("ul", { class: "list" }, [...p.history].reverse().map((x) => h("li", { class: "item small" }, h("span", { class: "grow" },
        h("span", {}, h("b", {}, x.byName), ` · ${x.action}${x.rev ? ` · revision ${x.rev}` : ""}`), x.note ? h("span", { class: "tiny faint" }, `“${x.note}”`) : null, h("span", { class: "tiny faint" }, ago(x.at))))))) : null);
}

function calendar(posts) {
  const now = new Date(), first = new Date(now.getFullYear(), now.getMonth(), 1), days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return h("section", { class: "card" }, h("h2", {}, now.toLocaleDateString(undefined, { month: "long", year: "numeric" })),
    h("div", { class: "calendar", role: "grid", "aria-label": "Content calendar" },
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => h("div", { class: "dow" }, d)),
      cells.map((d) => { if (!d) return h("div", {});
        const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const due = posts.filter((p) => p.scheduledFor === iso);
        return h("div", { class: "day", role: "gridcell", "aria-label": `${d}: ${due.length} post(s)` }, h("b", {}, d), due.map((p) => h("span", { class: `chip ${statusTone(p.status)}` }, p.asset?.name.split(".")[0]))); })),
    h("p", { class: "small faint" }, "Planned dates only. Publishing isn't connected in the preview."));
}

/* ================= AI Visibility ================= */
const MODULES = [["overview", "Overview"], ["search", "AI Search"], ["website", "Website"], ["social", "Social"], ["video", "Video"], ["competitive", "Competitive"], ["reports", "Reports"], ["actions", "Actions"]];
export async function visibilityView(out, [mod], ctx) {
  const ws = svc.currentWs(); const module = mod || "overview";
  const weeks = Number(mem("cue-vis-weeks") || 12);
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, ws?.name || ""), h("h1", {}, "AI Visibility"))),
    h("div", { class: "vis-banner", role: "note" }, icon("alert", 18), h("span", {}, h("b", {}, "FICTIONAL DEMO DATA"), " · every number on this page is invented for the preview. Live metrics will show their source, timestamp and calculation.")),
    h("div", { class: "vis-filters" }, wsPicker(() => ctx.rerenderShell()),
      h("select", { id: "vis-range", "aria-label": "Date range", onchange: (e) => { mem("cue-vis-weeks", e.target.value); ctx.refresh(); } },
        [[4, "Last 4 weeks"], [8, "Last 8 weeks"], [12, "Last 12 weeks"]].map(([v, l]) => h("option", { value: v, selected: v === weeks }, l)))),
    h("nav", { class: "vis-tabs", "aria-label": "Visibility modules" }, MODULES.map(([k, l]) => h("a", { class: k === module ? "on" : "", href: `#visibility-${k}`,
      "aria-current": k === module ? "page" : null }, svc.entitled(ws.id, k) ? null : icon("lock", 14), l))));
  if (!svc.entitled(ws.id, module)) {
    out.append(h("section", { class: "locked" }, h("div", { class: "veil" }, icon("lock", 30), h("h2", {}, `${MODULES.find((m) => m[0] === module)[1]} isn't in the ${PLANS[ws.plan]?.label} plan`),
      h("p", { class: "muted small", style: "max-width:46ch" }, "Your Menapoly producer can walk you through what it adds. Nothing is purchased from the preview."),
      h("a", { class: "btn", href: "#visibility-overview" }, "Back to Overview"))));
    return;
  }
  const { data: v } = await svc.visibility(ws.id, module, weeks);
  const method = (text) => h("p", { class: "method" }, h("b", {}, "When live: "), text);
  const card = (title, ...kids) => h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, title), fictional()), ...kids);
  const delta = (arr) => { const a = arr[0] || 0, b = arr[arr.length - 1] || 0; return a ? `${b >= a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%` : "—"; };
  const legend = (items) => h("div", { class: "legend" }, items.map(([l, c]) => h("span", {}, h("i", { style: `background:${c}` }), l)));
  const byCover = [...v.prompts].sort((a, b) => a.covered / a.total - b.covered / b.total), weakest = byCover[0], strongest = byCover[byCover.length - 1];

  if (module === "overview") {
    const last = (a) => a[a.length - 1], change = (a) => last(a) - a[0];
    const metric = (label, value, d, lead) => h("div", { class: `metric ${lead ? "lead" : ""}` }, h("span", { class: "label" }, label), h("span", { class: "value" }, value),
      d == null ? null : h("span", { class: `delta ${d > 0 ? "" : d < 0 ? "down" : "flat"}` }, `${d > 0 ? "▲ up" : d < 0 ? "▼ down" : "no change,"} ${Math.abs(d).toLocaleString()} vs week 1`));
    const competitive = svc.entitled(ws.id, "competitive"), search = svc.entitled(ws.id, "search");
    const rivals = v.competitors.slice(1), vs = mem("cue-vis-vs") || rivals[0].name, you = v.competitors[0], rival = rivals.find((c) => c.name === vs) || rivals[0];
    const top = v.actions[0];
    out.append(
      h("section", { class: "metrics", "aria-label": "Key metrics, fictional demo data" },
        metric("AI mentions per week", last(v.mentions).toLocaleString(), change(v.mentions), true),
        metric("Citations per week", last(v.citations).toLocaleString(), change(v.citations)),
        competitive ? metric("Share of voice", `${you.sov}%`, null) : metric("AI referrals per week", last(v.aiReferrals).toLocaleString(), change(v.aiReferrals)),
        metric("Site visits per week", last(v.visits).toLocaleString(), change(v.visits))),
      h("div", { class: "vis-grid" },
        h("div", { class: "col" },
          card("Mentions and citations", legend([["AI mentions", PALETTE[0]], ["Citations", PALETTE[1]]]),
            lineChart({ labels: v.weeks, series: [{ values: v.mentions, color: PALETTE[0], area: true }, { values: v.citations, color: PALETTE[1] }], label: `Weekly AI mentions rose from ${v.mentions[0]} to ${last(v.mentions)} and citations from ${v.citations[0]} to ${last(v.citations)}, fictional` }),
            method("Mentions and citations come from a scheduled prompt panel run against named AI assistants, stored with the prompt, the answer, the timestamp and the cited URLs.")),
          search ? card("Where AI assistants cite you", h("div", { class: "coverage" }, v.prompts.map((p) => h("div", { class: `crow ${p === weakest ? "low" : ""}` },
            h("span", {}, p === weakest ? h("b", {}, `${p.category} · lowest`) : p.category),
            h("span", { class: "bar-track", role: "img", "aria-label": `${p.covered} of ${p.total} prompts` }, h("i", { style: `width:${(p.covered / p.total) * 100}%` })),
            h("span", { class: "val" }, `${p.covered}/${p.total}`)))),
            h("p", { class: "small faint" }, `Evidence: ${v.sources.slice(0, 3).map((x) => `${x.title} ${x.share}%`).join(" · ")} · `, h("a", { href: "#visibility-search" }, "all sources"))) : null),
        h("div", { class: "col" },
          h("section", { class: "insight", "aria-label": "Insight" },
            h("div", { class: "panel-head" }, h("span", { class: "eyebrow", style: "display:inline-flex;gap:6px;align-items:center" }, icon("spark", 14), "Insight"), fictional()),
            h("p", { class: "editorial" }, search ? `Strong on “${strongest.category}”, quiet on “${weakest.category}”.` : `Mentions ${delta(v.mentions)} in ${weeks} weeks.`),
            h("dl", {},
              h("div", {}, h("dt", {}, h("span", { class: "n a", "aria-hidden": "true" }, "1"), "What happened"), h("dd", {}, `AI mentions went from ${v.mentions[0]} to ${last(v.mentions)} a week (${delta(v.mentions)}); citations from ${v.citations[0]} to ${last(v.citations)}.`)),
              h("div", {}, h("dt", {}, h("span", { class: "n b", "aria-hidden": "true" }, "2"), "Why it matters"), h("dd", {}, search ? `Assistants mention you on ${strongest.covered} of ${strongest.total} “${strongest.category}” prompts but only ${weakest.covered} of ${weakest.total} on “${weakest.category}”, so they recommend others there.` : "Steady growth means assistants are starting to trust your pages as a source.")),
              h("div", {}, h("dt", {}, h("span", { class: "n c", "aria-hidden": "true" }, "3"), "What to do next"), h("dd", {}, h("b", {}, top.t)))),
            h("button", { class: "btn primary lg block", onclick: () => exploreAction(top, ctx) }, "Explore this action")),
          competitive ? card("Share of voice", h("label", { class: "field" }, h("span", { class: "small faint" }, "Compare with"),
              h("select", { id: "vis-compare", onchange: (e) => { mem("cue-vis-vs", e.target.value); ctx.refresh(); } }, rivals.map((c) => h("option", { selected: c.name === rival.name }, c.name)))),
            h("div", { class: "sov" }, [you, rival].map((c, i) => h("div", { class: `srow ${i ? "" : "you"}` }, h("b", {}, c.name),
              h("span", { class: "bar-track", role: "img", "aria-label": `${c.sov}%` }, h("i", { style: `width:${c.sov}%` })), h("span", { class: "val" }, `${c.sov}%`)))),
            h("p", { class: "small faint" }, you.sov >= rival.sov ? `You're ${you.sov - rival.sov} points ahead of ${rival.name}.` : `${rival.name} is ${rival.sov - you.sov} points ahead.`)) : null,
          card("More recommended actions", h("ul", { class: "list" }, v.actions.slice(1, 3).map((a) => h("li", { class: "item" },
            h("span", { class: `chip ${a.p === "High" ? "warn" : a.p === "Medium" ? "accent" : ""}` }, a.p), h("span", { class: "grow" }, h("span", { class: "title small" }, a.t), h("span", { class: "tiny faint" }, a.why)))))))));
  }
  if (module === "search") out.append(
    card("Prompt-category coverage", barChart({ items: v.prompts.map((p) => ({ label: p.category, value: Math.round((p.covered / p.total) * 100) })), max: 100, unit: "%", label: "Share of prompts in each category where the brand is mentioned, fictional" }),
      method("Coverage = prompts in the category where an assistant's answer names the brand ÷ prompts run. The prompt list is agreed with the client.")),
    card("Where citations come from", h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Source"), h("th", {}, "Type"), h("th", { class: "num" }, "Share"))),
      h("tbody", {}, v.sources.map((s) => h("tr", {}, h("td", {}, s.title), h("td", {}, s.type), h("td", { class: "num" }, `${s.share}%`)))))),
      method("Each cited URL is stored with the answer it came from, so every row can be traced to evidence.")));
  if (module === "website") out.append(
    card("Site visits and AI-assistant referrals", legend([["Visits", PALETTE[1]], ["AI referrals ×20", PALETTE[2]]]),
      lineChart({ labels: v.weeks, series: [{ values: v.visits, color: PALETTE[1], area: true }, { values: v.aiReferrals.map((x) => x * 20), color: PALETTE[2] }], label: "Weekly visits and AI referrals, fictional" }),
      method("From the client's connected analytics property, read with a read-only grant. AI referrals are sessions whose referrer is a known assistant domain.")));
  if (module === "social") out.append(
    card("Engagement by platform", barChart({ items: v.social.map((s, i) => ({ label: s.platform, value: +s.engagement.toFixed(1), color: PALETTE[i] })), unit: "%", label: "Engagement rate by platform, fictional" }),
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Platform"), h("th", { class: "num" }, "Posts"), h("th", { class: "num" }, "Audience growth"))),
        h("tbody", {}, v.social.map((s) => h("tr", {}, h("td", {}, s.platform), h("td", { class: "num" }, s.posts), h("td", { class: "num" }, `+${s.growth}%`)))))),
      method("Engagement rate = (reactions + comments + shares + saves) ÷ impressions, from each platform's API with the client's authorization.")),
    card("Format mix", h("div", { class: "row", style: "align-items:center" }, donut({ items: v.formats.map((f, i) => ({ value: f.value, color: PALETTE[i] })), label: "Share of engagement by format, fictional" }),
      legend(v.formats.map((f, i) => [`${f.format} ${f.value}%`, PALETTE[i]])))));
  if (module === "video") out.append(
    h("div", { class: "stats" }, [["Videos produced", v.video.produced], ["Avg. watch (s)", v.video.avgWatch], ["Completion", `${v.video.completion}%`]].map(([l, n]) => h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, l)))),
    card("Production volume", lineChart({ labels: v.weeks, series: [{ values: v.citations.map((c) => Math.max(1, Math.round(c / 3))), color: PALETTE[3], area: true }], label: "Videos delivered per week, fictional" }),
      method("Volume comes from Cue's own delivery records. Watch time comes only from platforms that report it; others show “not reported”.")));
  if (module === "competitive") out.append(
    card("Share of voice (estimate)", barChart({ items: v.competitors.map((c, i) => ({ label: c.name, value: c.sov, color: i ? "#8E85A8" : PALETTE[0] })), max: 100, unit: "%", label: "Estimated share of voice, fictional" }),
      method("Estimate = brand's mentions ÷ all tracked brands' mentions across the same prompt panel and period. Competitors are named by the client; it is an estimate, not a market share.")));
  if (module === "reports") {
    const summary = `${ws.name} — AI Visibility summary (FICTIONAL DEMO DATA), last ${weeks} weeks.\nBrand mentions ${delta(v.mentions)}, citations ${delta(v.citations)}, AI referrals ${delta(v.aiReferrals)}.\nStrongest prompt category: ${[...v.prompts].sort((a, b) => b.covered / b.total - a.covered / a.total)[0].category}.\nWeakest: ${[...v.prompts].sort((a, b) => a.covered / a.total - b.covered / b.total)[0].category}.\nTop action: ${v.actions[0].t}.`;
    const pre = h("pre", { style: "white-space:pre-wrap;font-family:var(--body);margin:0" }, summary);
    out.append(card("Client summary", pre, h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => copyText(summary, pre) }, icon("copy", 16), "Copy summary"),
      h("button", { class: "btn", disabled: true, title: "Downloads are off in the preview" }, icon("download", 16), "Export (off in preview)")),
      method("Reports are generated from stored measurements only, list their sources, and are reviewed by a Menapoly producer before they reach the client.")));
  }
  if (module === "actions") out.append(card("Prioritized recommendations", h("ul", { class: "list" }, v.actions.map((a) => h("li", { class: "item" },
    h("span", { class: `chip ${a.p === "High" ? "warn" : a.p === "Medium" ? "accent" : ""}` }, a.p), h("span", { class: "grow" }, h("span", { class: "title" }, a.t), h("span", { class: "small faint" }, a.why)),
    h("button", { class: "btn sm", onclick: () => exploreAction(a, ctx) }, "Explore"))))));
}

/** Explain a recommendation and offer the next step. Nothing is created until the person submits the request form. */
function exploreAction(a, ctx) {
  const me = svc.me();
  const d = sheet("Recommended action", h("p", {}, fictional()), h("h3", {}, a.t), h("p", { class: "muted" }, `Why: ${a.why}`),
    h("p", { class: "small faint" }, "Priority: ", h("b", {}, a.p), ". Based on fictional demo data; live recommendations will link to their evidence."),
    me.role !== "editor" ? h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: () => { mem("cue-request-draft", JSON.stringify({ type: /reel|clip|cut/i.test(a.t) ? "short" : "promo", title: a.t, brief: `${a.t}. Why: ${a.why}` }));
        d.close(); ctx.go("request-new"); } }, "Start an editing request"),
      h("button", { class: "btn", onclick: () => d.close() }, "Not now")) : null,
    h("p", { class: "tiny faint" }, "The request form opens pre-filled; nothing is sent until you submit it."));
}

/* ================= Ask Cue ================= */
export async function askView(out, _p, ctx) {
  let msgs = svc.chat();
  const thread = h("div", { class: "chat", "aria-live": "polite" });
  const input = h("input", { id: "ask-input", placeholder: "Ask about projects, reviews, media…", autocomplete: "off", "aria-label": "Message Cue" });
  const proposals = Object.fromEntries((await svc.proposals()).map((p) => [p.id, p]));
  const renderMsg = (m) => {
    if (m.from === "me") return h("div", { class: "msg me" }, m.text);
    const p = m.proposalId ? proposals[m.proposalId] : null;
    return h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("spark", 16), "Cue"), h("p", {}, m.text),
      m.items?.length ? h("ul", { class: "list" }, m.items.map((x) => h("li", {}, h("a", { class: "item", href: `#${x.link}` }, h("span", { class: "grow" }, h("span", { class: "title small" }, x.title), h("span", { class: "tiny faint" }, x.sub)), icon("chevron", 16))))) : null,
      p ? h("div", { class: `proposal ${p.status === "Done" ? "done" : p.status === "Declined" ? "declined" : ""}` },
        h("div", { class: "row" }, h("span", { class: "eyebrow" }, "Proposed action"), p.status === "Waiting for you" ? h("span", { class: "chip warn" }, "Waiting for you") : null),
        h("b", {}, p.summary), p.payload?.brief ? h("p", { class: "small muted" }, p.payload.brief) : null,
        p.status === "Waiting for you" ? h("div", { class: "actions" },
          h("button", { class: "btn primary sm", onclick: async () => { try { await svc.decideProposal(p.id, true); toast("Done"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, icon("check", 16), "Approve"),
          h("button", { class: "btn sm", onclick: async () => { await svc.decideProposal(p.id, false); ctx.refresh(); } }, "Decline"))
          : h("span", { class: `chip ${p.status === "Done" ? "ok" : ""}` }, p.status)) : null,
      m.source ? h("span", { class: "tiny faint" }, `Based on: ${m.source}`) : null);
  };
  const draw = () => { thread.replaceChildren(...(msgs.length ? msgs.map(renderMsg) : [h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("spark", 16), "Cue"),
    h("p", {}, `Hi ${svc.me().name.split(" ")[0]}. I can find media, summarize reviews, draft editing briefs and explain your visibility report. Anything that changes data waits for your approval.`))])); };
  const send = async (text) => {
    if (!text.trim()) return;
    msgs.push({ from: "me", text }); draw(); input.value = "";
    try {
      const res = await assistant.respond(text);
      msgs.push({ from: "cue", text: res.text, items: res.items, source: res.source, proposalId: res.proposal?.id });
      if (res.proposal) proposals[res.proposal.id] = res.proposal;
    } catch (e) { msgs.push({ from: "cue", text: e.code === 403 ? "You don't have access to that." : e.message }); }
    svc.saveChat(msgs); draw(); thread.lastChild?.scrollIntoView({ block: "nearest" });
  };
  draw();
  const suggestions = ["What needs my approval?", "Summarize the latest review", "Draft a brief for cut-downs", "Find launch videos", "Explain my visibility report", "Repurposing ideas", "Project status"];
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Assistant"), h("h1", {}, "Ask Cue")),
      msgs.length ? h("button", { class: "btn sm ghost", onclick: () => { svc.saveChat([]); ctx.refresh(); } }, "Clear") : null),
    h("div", { class: "card", style: "padding:12px" }, h("div", { class: "row" }, demoBadge("Demo assistant"),
      h("span", { class: "small muted" }, `${assistant.name}: fixed answers from the fictional data your role can see. No AI model is connected.`))),
    thread,
    h("div", { class: "suggestions", role: "group", "aria-label": "Suggestions" }, suggestions.map((s) => h("button", { class: "btn sm", onclick: () => send(s) }, s))),
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, h("button", { class: "btn primary", type: "submit", "aria-label": "Send" }, icon("send", 18))));
}

/* ================= Tutorials (reached from Home announcements, the spotlight and search) ================= */
export async function lessonView(out, [lid], ctx) {
  const l = (await svc.lessons()).find((x) => x.id === lid);
  if (!l) { const e = new Error("That lesson doesn't exist."); e.code = 404; throw e; }
  const media = l.mediaInfo ? h("div", { class: "lesson-media" }, h("video", { src: l.mediaInfo.src, poster: l.mediaInfo.poster, controls: true, playsinline: true, preload: "metadata", "aria-label": l.title })) : null;
  media?.querySelector("video").addEventListener("ended", async () => { await svc.setProgress(l.id, 100); toast("Lesson complete"); });
  out.append(h("a", { href: "#home", class: "small" }, "← Home"), h("span", { class: "eyebrow" }, l.track), h("h1", {}, l.title),
    media, h("section", { class: "card" }, h("p", { style: "max-width:65ch" }, l.body), l.kind === "video" ? h("p", { class: "tiny faint" }, "Fictional demo lesson clip.") : null),
    h("div", { class: "actions" }, l.progress >= 100 ? h("span", { class: "chip ok" }, icon("check", 14), "Complete")
      : h("button", { class: "btn primary", onclick: async () => { await svc.setProgress(l.id, 100); toast("Marked complete"); ctx.refresh(); } }, icon("check", 18), "Mark complete")));
}

/* ================= Admin: clients, team ================= */
export async function clientsView(out) {
  const clients = await svc.clients();
  out.append(h("h1", {}, "Clients"), h("div", { class: "grid-2" }, clients.map((c) => h("section", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "avatar" }, c.monogram), h("div", { class: "stack", style: "gap:0" }, h("b", {}, c.name), h("span", { class: "small faint" }, c.industry))),
    h("div", { class: "row" }, h("span", { class: "chip accent" }, `${c.plan} plan`), h("span", { class: "chip" }, `${c.projects} project(s)`)),
    h("p", { class: "small muted" }, `People: ${c.people.join(", ")}`)))),
    h("p", { class: "small faint" }, "All clients and people are fictional."));
}

export async function teamView(out) {
  const [team, audit] = await Promise.all([svc.team(), svc.audit()]);
  const people = team.map((u) => h("li", { class: "item" }, avatar(u.name),
    h("span", { class: "grow" }, h("span", { class: "title" }, u.name), h("span", { class: "small faint" }, `${u.role} · ${u.title}`),
      h("span", { class: "tiny faint" }, u.assigned.length ? `Assigned: ${u.assigned.join(", ")}` : "No assignments"))));
  const log = audit.slice(0, 30).map((a) => h("li", { class: "item small" },
    h("span", { class: "grow" }, h("span", {}, h("b", {}, a.byName), ` ${a.action}: ${a.detail || ""}`), h("span", { class: "tiny faint" }, ago(a.at)))));
  out.append(h("h1", {}, "Team"),
    h("section", { class: "card" }, h("ul", { class: "list" }, people)),
    h("section", { class: "card" }, h("h2", {}, "Audit log"),
      log.length ? h("ul", { class: "list" }, log) : h("p", { class: "muted small" }, "Actions taken in this preview session will appear here.")));
}


/* ================= Settings ================= */
export async function settingsView(out, _p, ctx) {
  const me = svc.me();
  const fail = h("input", { type: "checkbox", id: "sim-outage", checked: svc.flags.failRequests, onchange: (e) => { svc.flags.failRequests = e.target.checked; toast(e.target.checked ? "Simulated outage on" : "Simulated outage off"); } });
  let confirmReset = false;
  const resetBtn = h("button", { class: "btn danger", onclick: () => {
    if (!confirmReset) { confirmReset = true; resetBtn.textContent = "Tap again to reset all demo data"; return; }
    svc.reset(); toast("Demo data reset"); ctx.rerenderShell(); } }, "Reset demo data");
  const rows = [
    ["Implemented in this preview", "Navigation, search, folders, editing requests, annotations, reviews, approvals, role-based access rules, social drafts, coaching progress (all stored on this device)."],
    ["Simulated", "Uploads (only the file name and size are kept), new versions, delivery exports, scheduling. Labelled “Simulated”."],
    ["Fictional", "Every client, person, clip and analytics number."],
    ["Not connected", "Your production Cue pilot, its database and storage, the Mac worker, AI models, social networks, analytics sources, email and payments."],
  ];
  out.append(h("h1", {}, "Settings"),
    h("section", { class: "card" }, h("h2", {}, "Signed in (demo)"), h("div", { class: "row" }, avatar(me.name), h("div", { class: "stack", style: "gap:0" }, h("b", {}, me.name), h("span", { class: "small faint" }, `${me.role} · ${me.title}`))),
      h("label", { for: "role-select" }, "View the preview as"),
      h("select", { id: "role-select", onchange: (e) => { svc.switchUser(e.target.value); toast("Role switched"); ctx.rerenderShell(); } },
        svc.users().map((u) => h("option", { value: u.id, selected: u.id === me.id }, `${u.name} — ${u.role}`)))),
    h("section", { class: "card" }, h("h2", {}, "What's real in this preview"), h("dl", { class: "stack", style: "margin:0" }, rows.map(([k, v]) =>
      h("div", {}, h("dt", { style: "font-weight:700" }, k), h("dd", { class: "small muted", style: "margin:2px 0 0" }, v))))),
    h("section", { class: "card" }, h("h2", {}, "Preview tools"),
      h("label", { class: "check", for: "sim-outage" }, fail, "Simulate a service outage (shows error states)"),
      h("p", { class: "small muted" }, "Resetting restores the fictional starting data on this device. It can't affect anything else."), resetBtn),
    h("p", { class: "tiny faint" }, "Menapoly Cue Studio preview · Menapoly Digital LLC · build for review, not for client use"));
}
