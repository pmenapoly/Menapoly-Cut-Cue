// Upload-first Editing Room data model (pure functions, no DOM, no storage). docs/studio/upload-first-design.md.
// A room exists from the moment media is added, before any request. Its brief is a draft until it is submitted; the
// submitted brief is frozen as an immutable snapshot. Notes are timestamped instructions (text, drawing or voice).
// Notes never consume revision rounds: only a formal change request on a submitted version does (service.decide).

export const ROOM_STAGES = ["Uploaded", "Preparing instructions", "Ready to submit", "Submitted for editing", "Assigned",
  "Being edited", "Ready for review", "Changes requested", "Approved", "Completed"];
export const NOTE_KINDS = ["text", "drawing", "voice"];
export const NOTE_PHASES = ["brief", "revision", "question"];
export const SHAPE_TYPES = ["arrow", "circle", "box", "highlight", "pen", "text", "graphic-zone", "rect"];
export const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin", "facebook", "x", "website", "other"];
export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"];
// Where the bytes of a file or recording live. Nothing in the preview is ever "uploaded".
export const STORAGE = {
  demo: "Demo clip (fictional, part of the preview)",
  session: "This session only: not uploaded, gone after a refresh",
  device: "Saved on this device only: not uploaded",
  none: "No file data: name and size only",
};
export const UPLOAD_OP = /^[A-Za-z0-9_-]{8,80}$/;

const bad = (message) => { const e = new Error(message); e.code = 400; return e; };
const str = (v, max) => String(v ?? "").trim().slice(0, max);

export function emptyFields(title = "") {
  return { title: str(title, 120), outcome: "", instructions: "", platforms: [], aspects: [], references: [], brand: [],
    requestedDate: null, length: "", music: "", captions: "", visual: "", checklist: [] };
}

/** Validates a partial brief update. Unknown fields are refused rather than silently stored. */
export function sanitizeBriefPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("Send the brief fields to change.");
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "title": out.title = str(v, 120); break;
      case "outcome": case "music": case "captions": out[k] = str(v, 500); break;
      case "visual": out.visual = str(v, 1000); break;
      case "instructions": out.instructions = str(v, 4000); break;
      case "length": out.length = str(v, 40); break;
      case "platforms": case "aspects": {
        const allowed = k === "platforms" ? PLATFORMS : ASPECTS;
        if (!Array.isArray(v) || v.some((x) => !allowed.includes(x))) throw bad(`Pick ${k} from: ${allowed.join(", ")}.`);
        out[k] = [...new Set(v)]; break;
      }
      case "brand":
        if (!Array.isArray(v) || v.length > 10) throw bad("Brand notes are a list of up to 10 lines.");
        out.brand = v.map((x) => str(x, 200)).filter(Boolean); break;
      case "references":
        if (!Array.isArray(v) || v.length > 10) throw bad("Add up to 10 references.");
        out.references = v.map((x) => {
          const label = str(x?.label, 120), url = x?.url ? str(x.url, 500) : null, assetId = x?.assetId ? str(x.assetId, 80) : null;
          // Stored as text only: the preview never opens or fetches a reference.
          if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw bad("References must be web addresses (http or https) or files in the library.");
          if (!label && !url && !assetId) throw bad("Each reference needs a label, a link or a library file.");
          return { label: label || url || "Library file", url, assetId };
        }); break;
      case "requestedDate":
        if (v !== null && v !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad("Pick a valid requested date.");
        out.requestedDate = v || null; break;
      case "checklist":
        if (!Array.isArray(v) || v.length > 30) throw bad("The checklist holds up to 30 items.");
        out.checklist = v.map((x) => ({ text: str(x?.text, 200), done: Boolean(x?.done) })).filter((x) => x.text); break;
      default: throw bad(`“${k}” isn't a brief field.`);
    }
  }
  return out;
}

/** Required before a brief can be marked ready. Returns the missing labels (empty when ready). */
export function briefMissing(f) {
  const miss = [];
  if (!f.title) miss.push("Title");
  if (!f.outcome) miss.push("Desired outcome");
  if (!f.instructions) miss.push("Editing instructions");
  if (!f.platforms.length && !f.aspects.length) miss.push("Platforms or shape");
  return miss;
}

/** Annotation geometry is normalised (0–1) so it fits any player size. Overlays only: the footage is never changed. */
export function validateShapes(shapes) {
  if (shapes == null) return [];
  if (!Array.isArray(shapes) || shapes.length > 50) throw bad("A drawing holds up to 50 shapes.");
  const unit = (n) => Math.max(0, Math.min(1, Number(n) || 0));
  return shapes.map((s) => {
    if (!SHAPE_TYPES.includes(s?.type)) throw bad(`Unknown drawing tool “${s?.type}”.`);
    const o = { type: s.type };
    for (const k of ["x", "y", "w", "h", "x2", "y2"]) if (s[k] != null) o[k] = unit(s[k]);
    if (Array.isArray(s.points)) { if (s.points.length > 500) throw bad("That freehand line is too long."); o.points = s.points.map(([x, y]) => [unit(x), unit(y)]); }
    if (s.label != null) o.label = str(s.label, 120);
    if (s.color != null) o.color = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#FFD25E";
    return o;
  });
}

/** Voice-note metadata. The recording itself stays in this browser; the preview refuses any claim of server storage. */
export function validateVoice(v) {
  if (!v || typeof v !== "object") throw bad("Missing the recording details.");
  if (!["device", "session"].includes(v.storage)) throw bad("The preview can't upload recordings: they stay on this device or in this session.");
  const duration = Number(v.duration);
  if (!(duration > 0 && duration <= 120)) throw bad("Voice notes are up to 2 minutes long.");
  if (!/^audio\/[a-z0-9.+-]+(;.*)?$/i.test(String(v.mime || ""))) throw bad("That isn't an audio recording.");
  const blobKey = str(v.blobKey, 80);
  if (!blobKey) throw bad("Missing the recording's local key.");
  return { blobKey, mime: String(v.mime).slice(0, 60), duration: Math.round(duration * 10) / 10, storage: v.storage, uploaded: false, transcript: null };
}

/** Lifecycle stage of a room, derived from its brief, request and review (never stored, so it can't drift). */
export function roomStage(room, { brief, request, review, hasNotes } = {}) {
  if (room.completedAt) return "Completed";
  if (review?.status === "Approved") return "Approved";
  if (review && review.versions?.length && review.status === "In review") return "Ready for review";
  if (request && /progress/i.test(request.status)) return "Being edited";
  if (review?.status === "Changes requested") return "Changes requested";
  if (request && /revision/i.test(request.status)) return "Being edited";
  if (request && request.assigneeId) return "Assigned";
  if (request) return "Submitted for editing";
  if (brief?.status === "ready") return "Ready to submit";
  const f = brief?.fields || {};
  const started = hasNotes || Boolean(f.outcome || f.instructions || f.platforms?.length || f.aspects?.length || f.references?.length
    || f.brand?.length || f.requestedDate || f.length || f.music || f.captions || f.visual || f.checklist?.length);
  return started ? "Preparing instructions" : "Uploaded";
}

/**
 * Phase of an instruction. Before the first edited version exists it is part of the briefing (client) or a clarifying
 * question (editing team); from the first version on, it is revision feedback. None of these use a revision round.
 */
export function notePhase({ role, versions, requested }) {
  if (requested === "question") return "question";
  if (!versions) return role === "client" ? "brief" : "question";
  return "revision";
}

// Stable JSON (sorted keys) and FNV-1a, so a frozen snapshot can be checked for later tampering.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export function fingerprint(v) {
  let h = 0x811c9dc5; const s = stable(v);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
export const snapshotBody = (s) => ({ briefId: s.briefId, roomId: s.roomId, ws: s.ws, rev: s.rev, fields: s.fields, noteIds: s.noteIds, by: s.by, at: s.at, source: s.source });
export const snapshotIntact = (s) => s.hash === fingerprint(snapshotBody(s));

/** Fields of a brief built from today's request + Editing Room instructions (migration and the request form). */
export function fieldsFromRequest(req, inst = {}) {
  const f = emptyFields(req?.title || "");
  f.instructions = str(inst.brief || req?.brief, 4000);
  f.aspects = ASPECTS.filter((a) => String(req?.aspect || "").includes(a));
  f.length = str(req?.length, 40);
  f.brand = (inst.brand || []).map((x) => str(x, 200));
  f.music = str(inst.audio, 500); f.captions = str(inst.captions, 500); f.visual = str(inst.visual, 1000);
  return f;
}

/**
 * Version 6 → 7: every existing Editing Room (videos[]) gets a room record with the SAME id, a submitted brief and an
 * immutable snapshot built from what the room already holds. Comments stay where they are and gain a phase. Revision
 * rounds, approvals, versions and links are not touched. Safe to run twice; never throws on odd records, it warns.
 */
export function migrate6(s, iso = new Date().toISOString(), { seeded = false } = {}) {
  for (const k of ["rooms", "briefs", "briefSnapshots", "notes", "uploadOps", "migrations"]) s[k] = s[k] || [];
  const from = s.version, warnings = [];
  let created = 0;
  const role = (uid) => (s.users || []).find((u) => u.id === uid)?.role;
  (s.assets || []).forEach((a) => { if (!a.storage) a.storage = a.localUrl ? "session" : a.media ? "demo" : "none"; if (a.roomId === undefined) a.roomId = null; });
  (s.videos || []).forEach((v) => {
    const req = (s.requests || []).find((r) => r.id === v.requestId), rv = (s.reviews || []).find((r) => r.id === v.reviewId);
    const p = (s.projects || []).find((x) => x.id === v.projectId);
    if (!p) warnings.push(`Room ${v.id}: its project is missing; kept as is.`);
    else if (p.ws !== v.ws) warnings.push(`Room ${v.id}: workspace differs from its project's; kept as is for review.`);
    if (!rv) warnings.push(`Room ${v.id}: its review record is missing.`);
    (rv?.comments || []).forEach((c) => {
      if (c.phase) return;
      const first = rv.versions?.[0];
      const before = !first || (c.version === 0 && c.at && first.at && c.at < first.at);
      c.phase = before ? (role(c.by) === "client" ? "brief" : "question") : "revision";
    });
    if (s.rooms.some((r) => r.id === v.id)) return; // already migrated
    const sources = req?.assetIds?.length ? req.assetIds.filter((aid) => s.assets.some((a) => a.id === aid))
      : s.assets.filter((a) => a.videoId === v.id && a.version == null && a.media && a.media === v.original?.media).map((a) => a.id);
    const createdBy = req?.by || v.history?.[0]?.by || null, createdAt = req?.at || v.history?.[0]?.at || iso;
    const fields = fieldsFromRequest(req || { title: v.title }, v.instructions);
    fields.title = str(v.title, 120);
    const brief = { id: `b_${v.id}`, roomId: v.id, ws: v.ws, status: "submitted", rev: 1, fields, updatedAt: createdAt, updatedBy: createdBy,
      editLog: [{ at: iso, by: null, rev: 1, field: "*", from: null, to: null, note: seeded ? "Demo brief (fictional seed data)" : "Built from the existing request and room instructions (demo migration)" }],
      snapshotIds: [`bs_${v.id}_1`] };
    const snap = { id: `bs_${v.id}_1`, briefId: brief.id, roomId: v.id, ws: v.ws, rev: 1, fields: JSON.parse(JSON.stringify(fields)), noteIds: [],
      by: createdBy, at: createdAt, source: seeded ? "seed" : "migrated" };
    snap.hash = fingerprint(snapshotBody(snap));
    s.briefs.push(brief); s.briefSnapshots.push(snap);
    s.rooms.push({ id: v.id, ws: v.ws, projectId: v.projectId, title: v.title, createdBy, createdAt, uploadOpId: null,
      sourceAssetIds: sources, mainAssetId: sources[0] || null, briefId: brief.id, requestId: v.requestId || null, reviewId: v.reviewId || null,
      completedAt: null, completedBy: null, rev: 0, migratedFrom: from,
      history: [{ at: iso, by: null, action: seeded ? "Demo room (fictional seed data)" : "Room record created from the existing Editing Room (demo migration)" }] });
    if (req) Object.assign(req, { roomId: v.id, briefId: brief.id, briefRev: 1, snapshotId: snap.id, requestedDate: req.requestedDate ?? null });
    created++;
  });
  (s.requests || []).forEach((r) => {
    if (r.roomId === undefined) { r.roomId = null; r.requestedDate = r.requestedDate ?? null; warnings.push(`Request ${r.id} has no Editing Room; it keeps working as before.`); }
  });
  if (!seeded) s.migrations.push({ from, to: 7, at: iso, rooms: created, warnings });
  s.version = 7;
  return s;
}
