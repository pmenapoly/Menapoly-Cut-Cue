// Event consumer (Cloudflare Queue in production; called inline when no queue is bound, e.g. local tests).
// Every event becomes at most one notification (deduplicated by source_key, so queue redelivery is harmless) and,
// when an Email Routing binding is configured, at most one email. Nothing here is sent to clients.
import { CueEvent, Env, newId, now } from "./util";

type Note = { kind: string; title: string; body: string; project_id: string | null; href: string | null; key: string };

async function describe(env: Env, e: CueEvent): Promise<Note | null> {
  const p = await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(e.project_id).first<{ name: string }>();
  const name = p?.name ?? "a project";
  const href = `/#/project/${e.project_id}`;
  if (e.type === "job_status") {
    const what = { transcribe: "Transcript", auto_edit: "Suggested edit", render: "Video" }[e.job_type] ?? "Job";
    if (e.status === "succeeded")
      return { kind: "job_done", title: `${what} ready in ${name}`,
               body: e.job_type === "auto_edit" ? "Review and approve the suggested edit." : "Finished on your Mac.",
               project_id: e.project_id, href, key: `job:${e.job_id}:succeeded` };
    if (e.status === "failed" || e.status === "dead")
      return { kind: "job_failed", title: `${what} failed in ${name}`,
               body: (e.error || "The worker reported an error.") + (e.status === "dead" ? " Retries are used up; retry it when the Mac is ready." : ""),
               project_id: e.project_id, href, key: `job:${e.job_id}:${e.status}` };
    return null;
  }
  if (e.type === "review") {
    const verb = { approved: "approved", changes_requested: "requested changes on", comment: "commented on" }[e.kind] ?? "reviewed";
    return { kind: `review_${e.kind}`, title: `${e.author} ${verb} ${name}`, body: e.body.slice(0, 500),
             project_id: e.project_id, href, key: `review:${e.event_id}` };
  }
  if (e.type === "upload_complete")
    return { kind: "upload_complete", title: `Upload finished: ${e.name}`, body: `Stored privately in ${name}.`,
             project_id: e.project_id, href, key: `upload:${e.asset_id}` };
  return null;
}

async function sendEmail(env: Env, note: Note) {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.EMAIL_TO) return false;
  // Cloudflare Email Routing "send_email" binding: only verified destination addresses can receive mail.
  const { EmailMessage } = await import("cloudflare:email");
  const raw = [
    `From: Menapoly Cue <${env.EMAIL_FROM}>`, `To: ${env.EMAIL_TO}`,
    `Subject: ${note.title.replace(/[\r\n]+/g, " ")}`, `Message-ID: <${newId("msg")}@${env.EMAIL_FROM.split("@")[1]}>`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
    note.body, "", "Open Menapoly Cue to see details.",
  ].join("\r\n");
  await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, env.EMAIL_TO, raw));
  return true;
}

export async function handleEvent(env: Env, e: CueEvent) {
  const note = await describe(env, e);
  if (!note) return;
  const id = newId("ntf");
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, kind, title, body, project_id, href, source_key, created_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, note.kind, note.title, note.body, note.project_id, note.href, note.key, now()).run();
  if (!r.meta.changes) return; // already handled (queue redelivery)
  try {
    if (await sendEmail(env, note)) await env.DB.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ?").bind(now(), id).run();
  } catch (err) {
    console.error("email failed", String(err)); // the in-app notification still exists; email is best-effort
  }
}
