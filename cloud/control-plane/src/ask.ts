// Ask Cue (cloud, built-in planner). Answers from the real D1 data and can only PROPOSE actions; an action runs only when the
// owner approves it (approveAction). No AI service is called, so nothing here costs money or sends data anywhere. When
// Claude is connected later it must keep the same contract: read tools + propose only.
import * as api from "./api";
import { Person, requireOwner } from "./auth";
import { audit, body, Env, HttpError, json, newId, now, rateLimit, str } from "./util";

type Row = Record<string, any>;
type Action = { kind: "create_project" | "create_job" | "archive_project"; project_id: string | null; params: Row; summary: string };
type Reply = { reply: string; items?: { label: string; href?: string; detail?: string }[]; action?: Row | null; mode: "built-in" };

const PRESET_WORDS: Record<string, string> = { youtube: "youtube", podcast: "podcast", reels: "reels", instagram: "reels",
  tiktok: "tiktok", linkedin: "linkedin", preview: "preview" };
const HELP = [
  "What needs my attention?",
  "New project Spring promo for Acme",
  "Suggest an edit for Market Mocha",
  "Transcribe Market Mocha",
  "Export Market Mocha for YouTube",
  "Is my Mac online?",
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

async function projects(env: Env): Promise<Row[]> {
  const { results } = await env.DB.prepare("SELECT id, name, client FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 200").all<Row>();
  return results;
}

/** The project the message names (longest name contained in the message), or the scoped one. */
function findProject(all: Row[], text: string, scoped: Row | null): Row | null {
  const t = ` ${norm(text)} `;
  const hits = all.filter((p) => norm(p.name).length >= 2 && t.includes(` ${norm(p.name)} `)).sort((a, b) => b.name.length - a.name.length);
  return hits[0] ?? scoped;
}

async function workersOnline(env: Env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM workers WHERE revoked_at IS NULL AND last_seen_at > ?").bind(now() - 120).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

async function latestMedia(env: Env, projectId: string) {
  return env.DB.prepare(`SELECT id, name, media_type FROM assets WHERE project_id = ? AND kind = 'source' AND status = 'ready'
                         AND media_type IN ('video','audio') ORDER BY created_at DESC LIMIT 1`).bind(projectId).first<Row>();
}

async function propose(env: Env, me: Person, a: Action): Promise<Row> {
  const id = newId("act");
  await env.DB.prepare(`INSERT INTO cue_actions (id, project_id, kind, params_json, summary, status, created_by, created_at)
                        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(id, a.project_id, a.kind, JSON.stringify(a.params), a.summary, me.email, now()).run();
  await audit(env, me.email, "ask.propose", id, { kind: a.kind });
  return { id, kind: a.kind, project_id: a.project_id, summary: a.summary, status: "pending" };
}

export async function ask(request: Request, env: Env, me: Person) {
  await rateLimit(env, `ask:${me.email}`, 30);
  const b = await body(request, 16 * 1024);
  const message = str(b.message, "message", { max: 500 });
  const scopedId = typeof b.project_id === "string" ? b.project_id : null;
  const all = await projects(env);
  const scoped = scopedId ? all.find((p) => p.id === scopedId) ?? null : null;
  const t = norm(message);
  const online = await workersOnline(env);
  const macNote = online ? "" : " Your Mac is offline, so it will wait in the queue until the Mac reconnects.";
  let out: Reply;

  const create = /^\s*(?:new|create|start|make)(?:\s+a)?(?:\s+new)?\s+project(?:\s+(?:called|named))?[\s:]+(.+?)\s*$/i.exec(message)?.[1];
  if (create) {
    const name = create.slice(0, 120);
    out = { mode: "built-in", reply: `I can create the project "${name}". Approve to create it.`,
            action: await propose(env, me, { kind: "create_project", project_id: null, params: { name }, summary: `Create project "${name}"` }) };
  } else if (/\b(attention|need(s)? me|to do|todo|waiting|status|what s up|whats up|overview|anything new)\b/.test(t)) {
    const [pending, failed, running] = await Promise.all([
      env.DB.prepare(`SELECT v.id, v.number, v.label, p.id AS pid, p.name FROM timeline_versions v JOIN projects p ON p.id = v.project_id
                      WHERE v.status = 'proposed' AND p.archived_at IS NULL ORDER BY v.created_at DESC LIMIT 10`).all<Row>(),
      env.DB.prepare(`SELECT j.id, j.type, j.error, p.id AS pid, p.name FROM jobs j JOIN projects p ON p.id = j.project_id
                      WHERE j.status IN ('failed','dead') AND p.archived_at IS NULL ORDER BY j.updated_at DESC LIMIT 10`).all<Row>(),
      env.DB.prepare(`SELECT j.id, j.type, j.status, j.stage, p.id AS pid, p.name FROM jobs j JOIN projects p ON p.id = j.project_id
                      WHERE j.status IN ('queued','leased','running') AND p.archived_at IS NULL ORDER BY j.created_at LIMIT 10`).all<Row>(),
    ]);
    const label: Record<string, string> = { transcribe: "Transcript", auto_edit: "Suggested edit", render: "Video export" };
    const items = [
      ...pending.results.map((v) => ({ label: `Approve edit ${v.number} in ${v.name}`, href: `#/project/${v.pid}`, detail: v.label })),
      ...failed.results.map((j) => ({ label: `${label[j.type] ?? j.type} failed in ${j.name}`, href: `#/project/${j.pid}`, detail: j.error ?? "" })),
      ...running.results.map((j) => ({ label: `${label[j.type] ?? j.type} in ${j.name}`, href: `#/project/${j.pid}`,
        detail: j.status === "queued" ? (online ? "next in line on your Mac" : "waiting for your Mac (offline)") : (j.stage || "working on your Mac") })),
    ];
    out = { mode: "built-in", items,
            reply: items.length ? `${pending.results.length} edit(s) need your approval, ${failed.results.length} job(s) failed, ${running.results.length} in progress. Your Mac is ${online ? "online" : "offline"}.`
                                : `Nothing needs you right now. Your Mac is ${online ? "online" : "offline"}.` };
  } else if (/\b(mac|worker)\b.*\b(online|offline|on|connected|working|up)\b|\bis (my )?mac\b/.test(t)) {
    const w = await env.DB.prepare("SELECT name, last_seen_at FROM workers WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1").first<Row>();
    out = { mode: "built-in", reply: online ? `Yes. ${w?.name ?? "Your Mac"} checked in within the last 2 minutes.`
      : w?.last_seen_at ? `No. ${w.name} last checked in ${Math.round((now() - w.last_seen_at) / 60)} minutes ago. Jobs wait until it reconnects.`
      : "No Mac has connected yet. Add one under Settings → Mac workers." };
  } else if (/\b(transcribe|transcript|captions? for)\b/.test(t) || /\b(suggest|rough cut|auto edit|autoedit|edit for|make an edit|cut down|tighten)\b/.test(t)) {
    const type = /\b(transcribe|transcript|captions? for)\b/.test(t) && !/\b(suggest|rough cut|auto edit|edit for)\b/.test(t) ? "transcribe" : "auto_edit";
    const p = findProject(all, message, scoped);
    if (!p) out = { mode: "built-in", reply: `Which project? Say its name, e.g. "${type === "transcribe" ? "Transcribe" : "Suggest an edit for"} ${all[0]?.name ?? "Market Mocha"}".` };
    else {
      const m = await latestMedia(env, p.id);
      if (!m) out = { mode: "built-in", reply: `${p.name} has no finished video or audio upload yet. Upload one first.`, items: [{ label: `Open ${p.name}`, href: `#/project/${p.id}` }] };
      else {
        const what = type === "transcribe" ? "transcribe" : "prepare a suggested edit of";
        out = { mode: "built-in", reply: `I can ask your Mac to ${what} ${m.name} in ${p.name}.${type === "auto_edit" ? " The edit comes back for your approval before anything is exported." : ""}${macNote}`,
                action: await propose(env, me, { kind: "create_job", project_id: p.id,
                  params: { type, asset_id: m.id, ...(type === "auto_edit" ? { request: message.slice(0, 500) } : {}) },
                  summary: `${type === "transcribe" ? "Transcribe" : "Suggest an edit for"} ${m.name} (${p.name})` }) };
      }
    }
  } else if (/\b(export|render|make a video|publish)\b/.test(t)) {
    const p = findProject(all, message, scoped);
    const preset = Object.entries(PRESET_WORDS).find(([w]) => t.split(" ").includes(w))?.[1] ?? "youtube";
    if (!p) out = { mode: "built-in", reply: `Which project should I export? e.g. "Export ${all[0]?.name ?? "Market Mocha"} for YouTube".` };
    else {
      const v = await env.DB.prepare("SELECT id, number, label FROM timeline_versions WHERE project_id = ? AND status = 'approved' ORDER BY number DESC LIMIT 1").bind(p.id).first<Row>();
      if (!v) {
        const proposed = await env.DB.prepare("SELECT number FROM timeline_versions WHERE project_id = ? AND status = 'proposed' LIMIT 1").bind(p.id).first<Row>();
        out = { mode: "built-in", reply: proposed ? `${p.name} has a suggested edit waiting for your approval. Approve it first, then export.`
                                                  : `${p.name} has no approved edit yet. Ask me to suggest one first.`, items: [{ label: `Open ${p.name}`, href: `#/project/${p.id}` }] };
      } else out = { mode: "built-in", reply: `I can export edit ${v.number} of ${p.name} with the ${preset} preset on your Mac.${macNote}`,
                     action: await propose(env, me, { kind: "create_job", project_id: p.id, params: { type: "render", version_id: v.id, preset },
                       summary: `Export edit ${v.number} of ${p.name} (${preset})` }) };
    }
  } else if (/\b(archive|hide|remove|delete)\b.*\bproject\b|\barchive\b/.test(t)) {
    const p = findProject(all, message, scoped);
    out = p ? { mode: "built-in", reply: `I can archive ${p.name}. It disappears from your list and queued work stops; stored files stay in private storage.`,
                action: await propose(env, me, { kind: "archive_project", project_id: p.id, params: {}, summary: `Archive project ${p.name}` }) }
            : { mode: "built-in", reply: "Which project should I archive? Say its name." };
  } else if (/\b(projects?|list|show)\b/.test(t)) {
    out = { mode: "built-in", reply: all.length ? `You have ${all.length} project(s).` : "You have no projects yet.",
            items: all.slice(0, 10).map((p) => ({ label: p.name, href: `#/project/${p.id}`, detail: p.client ?? "" })) };
  } else {
    out = { mode: "built-in", reply: "I'm the built-in Ask Cue (Claude isn't connected). I can answer from your projects and prepare actions for you to approve. Try one of these:",
            items: HELP.map((label) => ({ label })) };
  }
  return json(out);
}

export async function listActions(env: Env) {
  const { results } = await env.DB.prepare(`SELECT id, project_id, kind, summary, status, error, created_at, decided_at, result_json FROM cue_actions
                                            ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 30`).all<Row>();
  return json(results.map(({ result_json, ...a }) => ({ ...a, result: result_json ? JSON.parse(result_json) : null })));
}

const internal = (payload: unknown, key: string) => new Request("https://internal.invalid/v1", {
  method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(payload) });

export async function decideAction(env: Env, me: Person, id: string, decision: "approve" | "reject") {
  requireOwner(me);
  const a = await env.DB.prepare("SELECT * FROM cue_actions WHERE id = ?").bind(id).first<Row>();
  if (!a) throw new HttpError(404, "Action not found");
  if (a.status !== "pending") throw new HttpError(409, `This action was already ${a.status}.`);
  const t = now();
  if (decision === "reject") {
    await env.DB.prepare("UPDATE cue_actions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(me.email, t, id).run();
    await audit(env, me.email, "ask.reject", id);
    return json({ ok: true, status: "rejected" });
  }
  // Claim it first so a double tap can't run it twice.
  const claim = await env.DB.prepare("UPDATE cue_actions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(me.email, t, id).run();
  if (!claim.meta.changes) throw new HttpError(409, "This action was already decided.");
  const params = JSON.parse(a.params_json);
  let res: Response;
  try {
    if (a.kind === "create_project") res = await api.createProject(internal(params, `act-${id}`), env, me);
    else if (a.kind === "create_job") res = await api.createJob(internal(params, `act-${id}`), env, me, a.project_id);
    else res = await api.archiveProject(env, me, a.project_id);
  } catch (e) {
    const message = e instanceof HttpError ? e.message : "Something went wrong running this action.";
    await env.DB.prepare("UPDATE cue_actions SET status = 'failed', error = ? WHERE id = ?").bind(message, id).run();
    await audit(env, me.email, "ask.failed", id, { message });
    return json({ ok: false, status: "failed", error: message }, e instanceof HttpError ? e.status : 500);
  }
  const result = await res.json();
  await env.DB.prepare("UPDATE cue_actions SET result_json = ? WHERE id = ?").bind(JSON.stringify(result), id).run();
  await audit(env, me.email, "ask.approve", id, { kind: a.kind });
  return json({ ok: true, status: "approved", result, href: a.kind === "create_project" ? `#/project/${(result as Row).id}` : a.project_id ? `#/project/${a.project_id}` : "#/" });
}
