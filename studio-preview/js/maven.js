// Maven, Cue's assistant, available from every screen through the header launcher (lavender gradient). It opens over the current page,
// so a video keeps its place. In the preview, answers are deterministic and built only from data the current role can
// see; every state change is a proposal that runs the normal authorized service call only after "Approve".
import { h, icon, toast, sheet } from "./ui.js";
import { svc } from "./service.js";
import { active as assistant } from "./assistant.js";
import { fmtTime } from "./player.js";

export const VIDEO_PROMPTS = ["Summarize this video", "Suggest short clips", "Write a social caption", "Explain the editing instructions",
  "Help me request changes", "Suggest a new version", "Turn this video into a content idea"];
const GENERAL_PROMPTS = ["What needs my approval?", "Find launch videos", "Project status", "Repurposing ideas"];

const videoIdFromHash = () => (location.hash.match(/^#video-(v_\w+)$/) || [])[1] || null;

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

export function openMaven(ctx, preset) {
  const vid = videoIdFromHash();
  const thread = h("div", { class: "chat", "aria-live": "polite" });
  const input = h("input", { id: "maven-input", placeholder: vid ? "Ask about this video…" : "Ask Maven…", autocomplete: "off", "aria-label": "Message Maven" });
  const add = (el) => { thread.append(el); el.scrollIntoView({ block: "nearest" }); };
  const proposalEl = (p) => {
    const box = h("div", { class: "proposal" }, h("div", { class: "row" }, h("span", { class: "eyebrow" }, "Proposed action"), h("span", { class: "chip warn" }, "Waiting for you")), h("b", {}, p.summary));
    const decide = async (yes) => {
      try { const r = await svc.decideProposal(p.id, yes); box.classList.add(yes ? "done" : "declined");
        box.lastChild.replaceWith(h("span", { class: `chip ${yes ? "ok" : ""}`, style: "justify-self:start" }, yes ? icon("check", 13) : null, yes ? `Approved · ${r.status}` : r.status)); if (yes) { toast("Done"); document.dispatchEvent(new CustomEvent("cue:changed")); } }
      catch (e) { toast(e.code === 403 ? "You don't have permission to do that." : e.message, "err"); }
    };
    box.append(h("div", { class: "actions" }, h("button", { class: "btn primary sm", onclick: () => decide(true) }, icon("check", 16), "Approve"),
      h("button", { class: "btn sm", onclick: () => decide(false) }, "Decline")));
    return box;
  };
  const ask = async (text) => {
    if (!text.trim()) return;
    add(h("div", { class: "msg me" }, text)); input.value = "";
    try {
      const res = (vid && (await videoAnswer(text, vid))) || (await assistant.respond(text));
      // Each answer says what it is: information, a recommendation, a draft, or a proposed action that waits for approval.
      const kind = res.proposal ? null : /^draft/i.test(res.text) ? ["draft", "Draft · not saved"] : res.items?.length ? ["recommend", "Recommendation"] : ["info", "Information"];
      add(h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("spark", 16), "Maven"), kind ? h("span", { class: `kind ${kind[0]}` }, kind[1]) : null, h("p", {}, res.text),
        res.items?.length ? h("ul", { class: "list" }, res.items.map((x) => h("li", { class: "item small" }, h("span", { class: "grow" }, h("b", {}, x.title), h("span", { class: "tiny faint" }, x.sub))))) : null,
        res.note ? h("span", { class: "tiny faint" }, res.note) : null,
        res.proposal ? proposalEl(res.proposal) : null));
    } catch (e) { add(h("div", { class: "msg cue" }, e.code === 403 ? "You don't have access to that." : e.message)); }
  };
  const prompts = vid ? VIDEO_PROMPTS : GENERAL_PROMPTS;
  const d = sheet(vid ? "Maven · this video" : "Maven",
    h("p", { class: "small" }, h("span", { class: "chip demo" }, "Demo assistant"), " Fixed answers from fictional data. No AI model is connected. Changes wait for your approval."),
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
