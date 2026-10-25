// Ask Cue assistant adapter. The preview ships one provider: "demo", which answers deterministically from the fictional
// data the signed-in demo role can see. No model is called. A future provider (e.g. Claude through the server) must
// implement the same respond() contract, run server-side with the user's permissions, and may only return *proposals*;
// state changes happen only when the person approves them (svc.decideProposal → the normal authorized service call).
import { svc } from "./service.js";

export const providers = {
  demo: {
    name: "Cue demo assistant",
    live: false,
    async respond(text) { return demoRespond(text); },
  },
  // claude: { name: "Claude", live: true, respond: (text, ctx) => serverCall("/v1/ask", ...) }  ← not built in the preview
};
export const active = providers.demo;

const has = (t, ...words) => words.some((w) => t.includes(w));

async function demoRespond(raw) {
  const t = raw.toLowerCase().trim();
  const me = svc.me();
  const ws = svc.currentWs();
  if (!t) return { text: "Ask me about projects, reviews, media or your visibility report." };

  if (has(t, "approval", "approve", "waiting", "overdue", "needs me", "attention")) {
    const [reviews, posts, requests] = await Promise.all([svc.reviews(), me.role === "editor" ? [] : svc.posts(), svc.requests()]);
    const pending = reviews.filter((r) => r.status === "In review");
    const draftPosts = posts.filter((p) => /draft|awaiting/i.test(p.status));
    const overdue = requests.filter((r) => r.due && new Date(r.due) < new Date() && !/approved/i.test(r.status));
    const lines = [
      ...pending.map((r) => ({ title: `Review: ${r.title}`, sub: `${r.open} open comment(s) · version ${r.latest.n}`, link: `review-${r.id}` })),
      ...draftPosts.map((p) => ({ title: `Social draft: ${p.asset?.name}`, sub: p.status, link: "social" })),
      ...overdue.map((r) => ({ title: `Overdue: ${r.title}`, sub: `due ${r.due}`, link: `project-${r.projectId}` })),
    ];
    return { text: lines.length ? `${lines.length} item(s) are waiting:` : "Nothing is waiting on you right now.", items: lines,
      source: "Reviews, social drafts and request due dates you can see" };
  }
  if (has(t, "find", "where", "locate", "show me")) {
    const q = t.replace(/.*(find|where is|where are|locate|show me)\s*/, "").replace(/[?.]/g, "").replace(/\b(the|my|our|media|video|videos|clip|clips|file|files)\b/g, "").trim();
    const hits = (await svc.search(q || t)).slice(0, 6);
    return { text: hits.length ? `Here's what matches “${q || raw}”:` : `I couldn't find anything matching “${q || raw}” that you can access.`,
      items: hits.map((x) => ({ title: x.title, sub: `${x.type} · ${x.sub}`, link: x.link })), source: "Universal search over items your role can access" };
  }
  if (has(t, "brief", "request", "edit for", "cut down", "cutdown")) {
    const projects = await svc.projects();
    const p = projects.find((x) => t.includes(x.name.toLowerCase().split(" ")[0])) || projects[0];
    if (!p) return { text: "You don't have a project I can attach a brief to." };
    if (me.role === "editor") return { text: "Editors can't submit editing requests. A client or a Menapoly administrator can." };
    const payload = { projectId: p.id, type: "short", title: `Cut-downs from ${p.name}`, aspect: "9:16", length: "3 × 20 s", due: "",
      brief: `Three 20-second vertical cut-downs from the latest approved ${p.name} edit. Open on the product within two seconds, captions on, end card with the shop link.` };
    const prop = await svc.propose("request", payload, `Submit editing request “${payload.title}” for ${p.name}`);
    return { text: `I drafted a brief for ${p.name}. Nothing is sent until you approve it:`, proposal: prop, source: "Project brief and recent approvals" };
  }
  if (has(t, "summar", "feedback", "comments", "review")) {
    const reviews = await svc.reviews();
    const r = reviews.find((x) => x.status === "In review") || reviews[0];
    if (!r) return { text: "There are no reviews you can see yet." };
    const full = await svc.review(r.id);
    const open = full.comments.filter((c) => !c.resolved);
    return { text: `${full.title}: ${full.status.toLowerCase()}, version ${full.versions.length} of ${full.versions.length}. ${open.length} open comment(s), ${full.comments.length - open.length} resolved.`,
      items: open.map((c) => ({ title: `${Math.floor(c.t / 60)}:${String(Math.floor(c.t % 60)).padStart(2, "0")} — ${c.body}`, sub: c.byName, link: `review-${full.id}` })),
      source: "Review comments and audit trail" };
  }
  if (has(t, "repurpose", "reuse", "ideas", "clips from")) {
    const assets = (await svc.assets({ ws: ws?.id, channel: true })).slice(0, 4);
    return { text: assets.length ? "Approved media you could turn into more posts:" : "There's no approved media to repurpose yet.",
      items: assets.map((a) => ({ title: a.name, sub: a.kind === "video" ? "Cut 3 × 20 s verticals, pull a quote card, write a LinkedIn post" : "Use in a carousel", link: `asset-${a.id}` })),
      source: "Approved media in this workspace" };
  }
  if (has(t, "visibility", "analytics", "citation", "traffic", "seo", "ai search")) {
    if (me.role === "editor") return { text: "AI Visibility reports are for clients and Menapoly administrators." };
    if (!ws) return { text: "Pick a workspace first." };
    const v = await svc.visibility(ws.id, "overview");
    const m = v.data.mentions, c = v.data.citations;
    return { text: `In the FICTIONAL DEMO DATA for ${ws.name}, brand mentions went from ${m[0]} to ${m[m.length - 1]} over ${m.length} weeks and citations from ${c[0]} to ${c[c.length - 1]}. Top action: ${v.data.actions[0].t}.`,
      items: [{ title: "Open AI Visibility", sub: "Charts, sources and recommended actions", link: "visibility" }],
      source: "Fictional demo fixtures. Live data needs connected sources (see the integration plan)." };
  }
  if (has(t, "folder")) {
    if (!ws || me.role === "editor") return { text: "Only clients and administrators can create folders." };
    const name = (raw.match(/folder (?:called |named )?["“]?([^"”]+)["”]?/i)?.[1] || "Campaign assets").trim();
    const prop = await svc.propose("folder", { ws: ws.id, name }, `Create folder “${name}” in ${ws.name}`);
    return { text: "I can create that folder once you approve:", proposal: prop };
  }
  if (has(t, "status", "progress", "how is", "update")) {
    const projects = await svc.projects();
    return { text: projects.length ? "Here's where your projects stand:" : "You don't have any projects yet.",
      items: projects.map((p) => ({ title: p.name, sub: `${p.status} · due ${p.due}${p.pendingReview ? " · review waiting" : ""}`, link: `project-${p.id}` })),
      source: "Projects your role can access" };
  }
  if (has(t, "help", "how do", "what can")) {
    return { text: "I can show what needs your approval, find media, summarize a review, draft an editing brief, suggest repurposing ideas and explain your visibility report. Anything that changes data waits for your approval." };
  }
  return { text: "I'm the demo assistant, so I only understand a few requests. Try one of the suggestions below." };
}
