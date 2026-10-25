// Maven, Cue's assistant, available from every screen through the header launcher (lavender gradient). It opens over the current page,
// so a video keeps its place. In the preview, answers are deterministic and built only from data the current role can
// see; every state change is a proposal that runs the normal authorized service call only after "Approve".
import { h, icon, toast, sheet, busy } from "./ui.js";
import { svc } from "./service.js";
import { active as assistant } from "./assistant.js";
import { fmtTime } from "./player.js";

export const VIDEO_PROMPTS = ["Summarize this video", "Suggest short clips", "Write a social caption", "Explain the editing instructions",
  "Help me request changes", "Suggest a new version", "Turn this video into a content idea"];
const GENERAL_PROMPTS = ["What needs my approval?", "Find launch videos", "Project status", "Repurposing ideas"];


/** Deterministic answers about one video. Returns { text, items?, proposal? }. */
export async function videoAnswer(prompt, vid) {
  const v = await svc.video(vid), me = svc.me();
  const open = v.comments.filter((c) => !c.resolved), done = v.checklist.filter((t) => t.done).length;
  const latest = v.versions[v.versions.length - 1];
  const p = prompt.toLowerCase();
  const note = "This demo clip has no speech and no transcript, so I'm working from the brief, checklist and comments.";
  if (p.includes("summar")) return { text: `${v.title} (${v.projectName}) is “${v.status.toLowerCase()}”. It has ${v.versions.length - 1} edited version(s) after the original, ${open.length} open comment(s) and ${done} of ${v.checklist.length} checklist tasks done. Brief: ${v.instructions.brief}`, note };
  if (p.includes("short clip")) {
    const d = latest.duration || 10, marks = [0, d * 0.35, d * 0.7].map((t) => Math.round(t * 10) / 10);
    const items = marks.map((t, i) => ({ title: `Clip ${i + 1}: ${fmtTime(t)} – ${fmtTime(Math.min(d, t + d * 0.3))}`, sub: i === 0 ? "Opening: product first" : i === 1 ? "Middle: the story" : "Ending: the payoff and end card" }));
    if (!v.can["video.another"]) return { text: "Here are three evenly spaced moments to look at. Asking for clips is up to the client or a Menapoly admin.", items, note };
    const payload = { projectId: v.projectId, type: "highlights", title: `Short clips from ${v.title}`, aspect: "9:16", length: "3 × 15–20 s", due: "",
      brief: `Three short vertical clips from ${v.title}, starting near ${marks.map(fmtTime).join(", ")}. Product in the first two seconds, captions on.` };
    return { text: "Three moments that could become short clips. I can send this as an editing request once you approve:", items, note,
      proposal: await svc.propose("request", payload, `Request “${payload.title}”`) };
  }
  if (p.includes("caption")) {
    const caption = `${v.instructions.brief.split(".")[0]}. Out now.`;
    if (!v.can["video.share"] || v.reviewStatus !== "Approved") return { text: `Draft caption: “${caption}”${v.reviewStatus !== "Approved" ? " You can save it as a post once the video is approved." : ""}` };
    const asset = v.files.find((f) => f.videoId === v.id && f.channel) || v.files.find((f) => f.videoId === v.id);
    return { text: `Draft caption: “${caption}”. I can save it as a social draft (nothing is posted):`,
      proposal: await svc.propose("post", { assetId: asset.id, platforms: ["linkedin", "instagram"], captions: { linkedin: caption, instagram: caption } }, "Save a social draft with this caption") };
  }
  if (p.includes("explain")) {
    const i = v.instructions;
    return { text: `In plain words: ${i.brief} The look: ${i.visual} The sound: ${i.audio} Captions: ${i.captions}`,
      items: [...i.brand.map((b) => ({ title: b, sub: "Brand rule" })), ...i.deliverables.map((d) => ({ title: d.label, sub: "What gets delivered" }))] };
  }
  if (p.includes("request changes")) {
    if (!v.can["review.decide"]) return { text: me.role === "editor" ? "Editors don't request changes; the client or a Menapoly admin does. You can reply to their comments." : "You can comment, but requesting changes is for the client or an admin." };
    if (!/ready for review/i.test(v.status)) return { text: `This video is “${v.status.toLowerCase()}”, so there's nothing to send back right now.` };
    const lines = open.map((c) => `At ${fmtTime(c.t)}: ${c.body}`);
    const noteText = lines.length ? lines.join(" ") : "Please see my comments.";
    return { text: lines.length ? "I gathered your open comments into one change request:" : "There are no open comments yet. Add comments on the video first, or approve this note:",
      items: lines.map((l) => ({ title: l, sub: "Open comment" })),
      proposal: await svc.propose("changes", { reviewId: v.reviewId, note: noteText }, "Request changes with these notes") };
  }
  if (p.includes("new version")) {
    if (!v.can["video.another"]) return { text: "Asking for a new version is up to the client or a Menapoly admin." };
    const payload = { projectId: v.projectId, type: "short", title: `Vertical version of ${v.title}`, aspect: "9:16", length: "30 s", due: "",
      brief: `A 30-second vertical version of ${v.title} for Reels and Shorts. Same look and sound rules; product in the first two seconds.` };
    return { text: "A vertical 30-second version would reuse this edit for phones. I can request it once you approve:",
      proposal: await svc.propose("request", payload, `Request “${payload.title}”`) };
  }
  if (p.includes("content idea")) {
    const idea = `Behind the scenes of “${v.title}”: three things we decided in the edit and why.`;
    if (!v.can["video.feed"]) return { text: `Idea: ${idea}` };
    return { text: `Idea: ${idea} I can post it to your workspace feed as a discussion starter:`,
      proposal: await svc.propose("feed", { videoId: v.id, text: `Content idea: ${idea}` }, "Add this idea to the workspace feed") };
  }
  return null;
}

/* ---------- context: who is asking, and from where ---------- */
function where() {
  const t = location.hash.slice(1) || "home";
  if (/^video-/.test(t)) return { kind: "video", id: t.slice(6) };
  if (/^project-/.test(t)) return { kind: "project", id: t.slice(8) };
  if (/^visibility/.test(t)) return { kind: "visibility" };
  return { kind: t.split("-")[0] || "home" };
}
const PROMPTS = {
  video: [...VIDEO_PROMPTS, "What's unresolved?", "What should happen next?"],
  project: ["Summarize this project", "What's unresolved?", "What should happen next?", "Draft an editing request"],
  visibility: ["Explain these numbers", "What should we do next?", "Which prompts are we missing?"],
  other: ["What should I do next?", "What needs my approval?", "Repurposing ideas", "Draft an editing request", "Where do I upload footage?", "Who am I signed in as?"],
};
const ROLE = { admin: "Menapoly administrator", client: "client", editor: "editor" };
const NAV_HELP = [
  [/upload|footage|add files?/, "Upload footage in the Library: Add files. In the preview only the name and size are kept.", "library", "Open the Library"],
  [/request|brief|order/, "Start a new editing request from Media Studio → New editing request. You can attach footage and start from a template.", "request-new", "New editing request"],
  [/template/, "Templates live in Media Studio → Templates. Make one from any video's More actions → Make a template.", "studio", "Open Media Studio"],
  [/review|approve|feedback/, "Videos waiting for you are under Review. Open one to comment on a frame, request changes or approve.", "review", "Open Review"],
  [/social|post|share/, "Social Sharing prepares drafts from approved videos. Nothing is published from the preview.", "social", "Open Social Sharing"],
  [/visibility|analytics|metric/, "AI Visibility shows how AI assistants mention you. Every number in the preview is fictional demo data.", "visibility", "Open AI Visibility"],
  [/role|switch|sign/, "Switch the demo person from the avatar at the top right.", "settings", "Open Settings"],
  [/notification|inbox/, "Notifications are in the Inbox (the bell).", "inbox", "Open the Inbox"],
];

async function openComments(scope) {
  const vids = (await svc.videos()).filter((v) => !scope.projectId || v.projectId === scope.projectId).filter((v) => !scope.videoId || v.id === scope.videoId);
  const out = [];
  for (const v of vids) { const full = await svc.video(v.id);
    full.comments.filter((c) => !c.resolved).forEach((c) => out.push({ title: `${fmtTime(c.t)} · ${c.body}`, sub: `${v.title} · ${c.version ? `v${c.version}` : "original"} · ${c.byName}${c.assigneeName ? ` · for ${c.assigneeName}` : ""}`, link: `video-${v.id}` })); }
  return out;
}

/** Next steps for this person, computed only from records their role can see. */
async function nextSteps(scope = {}) {
  const me = svc.me(), vids = (await svc.videos()).filter((v) => !scope.projectId || v.projectId === scope.projectId);
  const steps = [];
  if (me.role === "editor") {
    vids.filter((v) => v.editor === me.name).forEach((v) => {
      if (v.status === "Waiting to start") steps.push({ title: `Start editing “${v.title}”`, sub: "Assigned to you, not started", link: `video-${v.id}` });
      if (v.status === "Changes requested") steps.push({ title: `Work through the feedback on “${v.title}”`, sub: `${v.open} open comment(s)`, link: `video-${v.id}` });
      if (v.status === "Being edited") steps.push({ title: `Finish and submit “${v.title}”`, sub: `${v.done} of ${v.tasks} checklist tasks done`, link: `video-${v.id}` });
    });
  } else {
    vids.forEach((v) => {
      if (v.status === "Ready for review") steps.push({ title: `Review “${v.title}”`, sub: `Version ${v.versions} is waiting · ${v.open} open comment(s)`, link: `video-${v.id}` });
      if (v.status === "Approved") steps.push({ title: `Make more from “${v.title}”`, sub: "Approved, so it can be reused", link: `video-${v.id}` });
    });
    if (me.role === "admin") {
      const { rows } = await svc.production();
      rows.filter((r) => !r.assigneeId && !/approved/i.test(r.status) && (!scope.projectId || r.projectId === scope.projectId))
        .forEach((r) => steps.push({ title: `Assign an editor to “${r.title}”`, sub: `${r.workspace} · ${r.due ? `due ${r.due}` : "no deadline"}`, link: r.videoId ? `video-${r.videoId}` : "studio-board" }));
      rows.filter((r) => r.overdue).forEach((r) => steps.push({ title: `Chase “${r.title}”`, sub: `Overdue · ${r.assignee || "no editor"}`, link: r.videoId ? `video-${r.videoId}` : "studio-board" }));
    }
    if (!scope.projectId && me.role !== "editor") {
      const posts = await svc.posts(svc.currentWs()?.id).catch(() => []);
      posts.filter((p) => p.canReview).forEach((p) => steps.push({ title: `Review the social draft for ${p.asset?.name}`, sub: `Submitted by ${p.submittedByName} · nothing is posted`, link: "social" }));
      posts.filter((p) => p.status === "Changes requested" && p.by === me.id).forEach((p) => steps.push({ title: `Revise your social draft for ${p.asset?.name}`, sub: `${p.reviewerName} asked for changes`, link: "social" }));
    }
  }
  return steps;
}

/** Several independent suggestions, each approved (or declined) on its own. Nothing happens until approval. */
async function repurposing(scope = {}) {
  const me = svc.me(), ws = svc.currentWs();
  if (me.role === "editor") return { text: "Repurposing decisions belong to the client or a Menapoly admin. You'll see any new requests in your queue." };
  const approved = (await svc.videos({ ws: ws?.id })).filter((v) => v.status === "Approved" && (!scope.videoId || v.id === scope.videoId)).slice(0, 2);
  if (!approved.length) return { text: "Nothing is approved yet, so there's nothing to repurpose. Approve a video first; I'll suggest what to make from it." };
  const proposals = [];
  for (const v of approved) {
    const full = await svc.video(v.id);
    if (full.can["video.another"]) proposals.push(await svc.propose("another", { videoId: v.id, type: "short", title: `Three 15-second clips from ${v.title}`, aspect: "9:16", length: "3 × 15 s",
      brief: `Three 15-second vertical clips from the approved ${v.title}. Product or payoff in the first two seconds; captions on.` }, `Request three 15-second clips from “${v.title}”`));
    const asset = full.files.find((f) => f.videoId === v.id && f.channel);
    if (full.can["video.share"] && asset) { const caption = `${full.instructions.brief.split(".")[0]}.`;
      proposals.push(await svc.propose("post", { assetId: asset.id, platforms: ["linkedin", "instagram"], captions: { linkedin: caption, instagram: caption } }, `Save a social draft for “${v.title}” (nothing is posted)`)); }
    if (full.can["video.feed"]) proposals.push(await svc.propose("feed", { videoId: v.id, text: `Behind the scenes of “${v.title}”: what we decided in the edit and why.` }, `Share a behind-the-scenes idea about “${v.title}” in the workspace feed`));
  }
  return { text: `Here's what you could make from ${approved.map((v) => `“${v.title}”`).join(" and ")}. Approve only the ones you want:`, proposals,
    note: "Ideas come from the approved videos' briefs and formats. No video analysis is done in the preview." };
}

async function visibilityAnswer(t) {
  const me = svc.me(), ws = svc.currentWs();
  if (me.role === "editor") return { text: "AI Visibility reports are for clients and Menapoly administrators." };
  const { data: v, planLabel } = await svc.visibility(ws.id, "overview", 12);
  const last = (a) => a[a.length - 1], pct = (a) => Math.round(((last(a) - a[0]) / a[0]) * 100);
  const sorted = [...v.prompts].sort((a, b) => a.covered / a.total - b.covered / b.total);
  const search = svc.entitled(ws.id, "search"), comp = svc.entitled(ws.id, "competitive");
  const label = "FICTIONAL DEMO DATA: invented for the preview; no analytics are connected.";
  if (/missing|prompt|gap/.test(t)) {
    if (!search) return { text: `Prompt coverage isn't in the ${planLabel} plan.`, note: label };
    return { text: "Prompt categories where assistants mention you least:", items: sorted.slice(0, 3).map((p) => ({ title: p.category, sub: `mentioned on ${p.covered} of ${p.total} prompts`, link: "visibility-search" })), note: label };
  }
  if (/next|do|action|recommend/.test(t)) {
    return { text: "The recommended actions, highest priority first. “Explore” on the AI Visibility page opens a pre-filled request; nothing is sent until you submit it.",
      items: v.actions.slice(0, 3).map((a) => ({ title: a.t, sub: `${a.p} · ${a.why}`, link: "visibility-actions" })), note: label };
  }
  return { text: `Over 12 weeks, AI mentions went from ${v.mentions[0]} to ${last(v.mentions)} a week (${pct(v.mentions) >= 0 ? "+" : ""}${pct(v.mentions)}%), and citations from ${v.citations[0]} to ${last(v.citations)}.`,
    items: [
      { title: "AI mentions", sub: "How often a tracked AI assistant names you when answering the agreed prompt list" },
      { title: "Citations", sub: "Answers that link to one of your pages as a source" },
      ...(comp ? [{ title: `Share of voice ${v.competitors[0].sov}%`, sub: "Your mentions ÷ all tracked brands' mentions. An estimate, not a market share" }] : []),
      ...(search ? [{ title: `Weakest area: ${sorted[0].category}`, sub: `${sorted[0].covered} of ${sorted[0].total} prompts` }] : []),
    ], note: label };
}

async function draftRequest(scope = {}) {
  const me = svc.me();
  if (me.role === "editor") return { text: "Editors don't create requests; a client or a Menapoly admin does." };
  const projects = (await svc.projects()).filter((p) => !scope.projectId || p.id === scope.projectId).filter((p) => me.role === "admin" || p.ws === svc.currentWs()?.id);
  const p = projects[0]; if (!p) return { text: "There's no project I can attach a request to." };
  const payload = { projectId: p.id, type: "short", title: `Cut-downs for ${p.name}`, aspect: "9:16", length: "3 × 20 s", due: "",
    brief: `Three 20-second vertical cut-downs for ${p.name}. ${p.brief} Product in the first two seconds, captions on.` };
  return { text: `A draft request for ${p.name}, built from the project brief. Approve it to submit, or open the form to edit it first:`,
    proposal: await svc.propose("request", payload, `Submit “${payload.title}”`), items: [{ title: "Edit it in the request form instead", sub: "Nothing is sent until you submit", link: "request-new" }] };
}

/** Answers from the current screen's context. Returns null when the question isn't recognised here. */
async function contextAnswer(text, at) {
  const t = text.toLowerCase(), me = svc.me(), ws = svc.currentWs();
  if (/who am i|signed in|my role|what can i/.test(t)) {
    const can = me.role === "admin" ? "see every workspace, assign editors and approve" : me.role === "editor" ? "work on the videos assigned to you, tick checklist tasks and submit versions; you don't approve"
      : `request edits, review and approve videos, and prepare social drafts in ${ws?.name}`;
    return { text: `You're ${me.name}, signed in as a ${ROLE[me.role]}. You can ${can}.` };
  }
  if (/unresolved|open comment|open feedback|outstanding/.test(t)) {
    const items = await openComments({ videoId: at.kind === "video" ? at.id : null, projectId: at.kind === "project" ? at.id : null });
    return { text: items.length ? `${items.length} piece(s) of feedback are still open:` : "All feedback here is resolved.", items };
  }
  if (/next|to do|what should/.test(t) && at.kind !== "visibility") {
    const scope = at.kind === "project" ? { projectId: at.id } : at.kind === "video" ? { projectId: (await svc.video(at.id)).projectId } : {};
    const items = await nextSteps(scope);
    return { text: items.length ? "Suggested next steps, from what's waiting right now:" : "Nothing is waiting on you here right now.", items };
  }
  if (at.kind === "visibility" || /visibility|metric|numbers|citation|share of voice/.test(t)) return visibilityAnswer(t);
  if (/repurpos|reuse|make more|ideas/.test(t)) return repurposing(at.kind === "video" ? { videoId: at.id } : {});
  if (/draft .*request|new request|editing request/.test(t)) return draftRequest(at.kind === "project" ? { projectId: at.id } : {});
  if (/summar/.test(t) && at.kind === "project") {
    const p = await svc.project(at.id), vids = (await svc.videos()).filter((v) => v.projectId === at.id);
    return { text: `${p.name}: ${p.status.toLowerCase()}, due ${p.due}. ${p.requests.length} request(s), ${vids.length} video(s). Brief: ${p.brief}`,
      items: vids.map((v) => ({ title: v.title, sub: `${v.status} · ${v.done}/${v.tasks} tasks · ${v.open} open comment(s)`, link: `video-${v.id}` })) };
  }
  if (/where|how do i|how can i|find the|navigate/.test(t)) {
    const hit = NAV_HELP.find(([re]) => re.test(t));
    if (hit) return { text: hit[1], items: [{ title: hit[3], sub: "Go there", link: hit[2] }] };
  }
  return null;
}

export function openMaven(ctx, preset) {
  const at = where(), vid = at.kind === "video" ? at.id : null, me = svc.me(), ws = svc.currentWs();
  const thread = h("div", { class: "chat", "aria-live": "polite" });
  const input = h("input", { id: "maven-input", placeholder: vid ? "Ask about this video…" : "Ask Maven…", autocomplete: "off", "aria-label": "Message Maven" });
  const add = (el) => { thread.append(el); el.scrollIntoView({ block: "nearest" }); };
  const proposalEl = (p) => {
    const box = h("div", { class: "proposal" }, h("div", { class: "row" }, h("span", { class: "eyebrow" }, "Proposed action"), h("span", { class: "chip warn" }, "Waiting for you")), h("b", {}, p.summary));
    const decide = (yes) => busy(async () => {
      try { const r = await svc.decideProposal(p.id, yes); box.classList.add(yes ? "done" : "declined");
        box.lastChild.replaceWith(h("span", { class: `chip ${yes ? "ok" : ""}`, style: "justify-self:start" }, yes ? icon("check", 13) : null, yes ? `Approved · ${r.status}` : r.status)); if (yes) { toast("Done"); document.dispatchEvent(new CustomEvent("cue:changed")); } }
      catch (e) { toast(e.code === 403 ? "You don't have permission to do that." : e.message, "err"); }
    });
    box.append(h("div", { class: "actions" }, h("button", { class: "btn primary sm", onclick: decide(true) }, icon("check", 16), "Approve"),
      h("button", { class: "btn sm", onclick: decide(false) }, "Decline")));
    return box;
  };
  const ask = async (text) => {
    if (!text.trim()) return;
    add(h("div", { class: "msg me" }, text)); input.value = "";
    try {
      const res = (await contextAnswer(text, at)) || (vid && (await videoAnswer(text, vid))) || (await assistant.respond(text));
      const props = res.proposals || (res.proposal ? [res.proposal] : []);
      // Each answer says what it is: information, a recommendation, a draft, or proposed actions that wait for approval.
      const kind = props.length ? null : /^draft/i.test(res.text) ? ["draft", "Draft · not saved"] : res.items?.length ? ["recommend", "Recommendation"] : ["info", "Information"];
      add(h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("spark", 16), "Maven"), kind ? h("span", { class: `kind ${kind[0]}` }, kind[1]) : null, h("p", {}, res.text),
        res.items?.length ? h("ul", { class: "list" }, res.items.map((x) => { const body = h("span", { class: "grow" }, h("b", {}, x.title), h("span", { class: "tiny faint" }, x.sub));
          return h("li", {}, x.link ? h("a", { class: "item small", href: `#${x.link}`, onclick: () => d.close() }, body, icon("chevron", 16)) : h("div", { class: "item small" }, body)); })) : null,
        res.note ? h("span", { class: "tiny faint" }, res.note) : null,
        ...props.map(proposalEl)));
    } catch (e) { add(h("div", { class: "msg cue" }, e.code === 403 ? "You don't have access to that." : e.message)); }
  };
  const prompts = PROMPTS[at.kind] || PROMPTS.other;
  const here = vid ? "this video" : at.kind === "project" ? "this project" : at.kind === "visibility" ? "AI Visibility" : null;
  const d = sheet(here ? `Maven · ${here}` : "Maven",
    h("p", { class: "small" }, h("span", { class: "chip demo" }, "Demo assistant"), " Fixed answers from fictional data. No AI model is connected. Changes wait for your approval."),
    h("p", { class: "tiny faint", "data-context": at.kind }, `Signed in as ${me.name} (${ROLE[me.role]}${me.role === "client" && ws ? `, ${ws.name}` : ""}). Maven only uses what this role can see.`),
    h("div", { class: "suggestions", role: "group", "aria-label": "Suggested questions" }, prompts.map((p) => h("button", { class: "btn sm", onclick: () => ask(p) }, p))),
    thread,
    h("form", { class: "row nowrap", onsubmit: (e) => { e.preventDefault(); ask(input.value); } }, input, h("button", { class: "btn primary", type: "submit", "aria-label": "Send" }, icon("send", 18))),
    vid ? null : h("a", { class: "small", href: "#ask", onclick: () => d.close() }, "Open the full Ask Cue page"));
  d.classList.add("maven-sheet");
  if (preset) ask(preset);
  return d;
}

/** Launcher for the header: on every screen, never covering content. */
export const mavenButton = (ctx) => h("button", { class: "maven-btn", "aria-label": "Ask Maven, Cue's assistant", onclick: () => openMaven(ctx) }, icon("spark", 20), h("span", {}, "Maven"));
