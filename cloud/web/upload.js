// Resumable, original-quality uploads straight to private storage. The Worker only hands out short-lived part URLs;
// the bytes never pass through it. Progress is measured from parts that storage confirmed, never estimated.
//
// Interruption handling: each part is retried with backoff; if the phone goes offline we wait for the "online" event.
// If the page is closed, the upload session is remembered in IndexedDB (keyed by file name, size and date). Picking
// the same file again asks the server which parts already arrived and sends only the rest.
import { api } from "./api.js";

const DB_NAME = "menapoly-cue-uploads";
const MiB = 1024 * 1024;
const PART_SIZE = 8 * MiB;
const CONCURRENCY = 3;
const EXT_TYPES = {
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", wav: "audio/wav", mp3: "audio/mpeg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", aif: "audio/aiff", aiff: "audio/aiff",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", srt: "application/x-subrip", vtt: "text/vtt",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function contentTypeFor(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  // Prefer the extension mapping: phones report odd types (e.g. "" or "video/3gpp") that the server would reject.
  return EXT_TYPES[ext] || file.type || "application/octet-stream";
}

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("sessions");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function store(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", mode);
      const req = fn(tx.objectStore("sessions"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined; // private browsing etc.: uploads still work, they just can't resume after a reload
  }
}
const remember = (key, value) => store("readwrite", (s) => s.put(value, key));
const recall = (key) => store("readonly", (s) => s.get(key));
const forget = (key) => store("readwrite", (s) => s.delete(key));
export const pendingUploads = () => store("readonly", (s) => s.getAll());

function hashFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      if (e.data.progress != null) onProgress(e.data.progress);
      if (e.data.sha256) { worker.terminate(); resolve(e.data.sha256); }
      if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "Could not read the file")); };
    worker.postMessage({ file });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const online = () => navigator.onLine ? Promise.resolve() : new Promise((r) => addEventListener("online", r, { once: true }));

/**
 * Upload one file. onState({phase, fraction?, message}) — phase: checking | uploading | finishing | done | waiting.
 * fraction is measured (bytes hashed / bytes confirmed by storage); "waiting" leaves the last measured value in place.
 */
export async function uploadFile(projectId, file, onState, signal) {
  const key = `${projectId}:${file.name}:${file.size}:${file.lastModified}`;
  let saved = await recall(key);
  let sha256 = saved?.sha256;
  if (!sha256) {
    onState({ phase: "checking", fraction: 0, message: "Fingerprinting the file so its integrity can be verified" });
    sha256 = await hashFile(file, (f) => onState({ phase: "checking", fraction: f, message: "Fingerprinting the file" }));
    saved = { key, projectId, name: file.name, size: file.size, sha256 };
    await remember(key, saved);
  }
  let session = saved.session, done = new Set();
  if (session) {
    const status = await api(`/v1/uploads/${session.id}`).catch(() => null);
    if (status?.status === "completed") { await forget(key); return { asset_id: session.asset_id, resumed: true }; }
    if (status?.status === "open" && status.expires_at > Date.now() / 1000 + 600) done = new Set(status.parts_done);
    else session = null;
  }
  if (!session) {
    session = await api(`/v1/projects/${projectId}/uploads`, {
      method: "POST", idempotencyKey: `up-${sha256.slice(0, 24)}-${file.size}-${Date.now()}`,
      body: { filename: file.name, content_type: contentTypeFor(file), size: file.size, sha256, part_size: PART_SIZE },
    });
    saved.session = session;
    await remember(key, saved);
  }
  const partSize = session.part_size, count = session.part_count;
  const sizeOf = (n) => (n === count ? file.size - (count - 1) * partSize : partSize);
  let confirmed = [...done].reduce((s, n) => s + sizeOf(n), 0);
  const report = () => onState({ phase: "uploading", fraction: confirmed / file.size,
    message: done.size ? `${done.size} of ${count} parts stored` : "Starting upload" });
  report();

  for (let round = 0; round < 3; round++) {
    const todo = [];
    for (let n = 1; n <= count; n++) if (!done.has(n)) todo.push(n);
    while (todo.length) {
      if (signal?.aborted) throw new DOMException("Upload paused", "AbortError");
      const batch = todo.splice(0, 12);
      const { urls } = await api(`/v1/uploads/${session.id}/parts`, { method: "POST", body: { parts: batch } });
      let next = 0;
      const lanes = Array.from({ length: CONCURRENCY }, async () => {
        while (next < urls.length) {
          const item = urls[next++];
          await putPart(session.id, item, file.slice((item.part - 1) * partSize, item.part * partSize), signal, onState);
          done.add(item.part);
          confirmed += sizeOf(item.part);
          report();
        }
      });
      await Promise.all(lanes);
    }
    onState({ phase: "finishing", fraction: 1, message: "Checking every part arrived" });
    try {
      const result = await api(`/v1/uploads/${session.id}/complete`, { method: "POST" });
      await forget(key);
      onState({ phase: "done", fraction: 1, message: "Stored privately" });
      return result;
    } catch (e) {
      if (e.status !== 409) throw e;
      for (const n of e.data?.missing_parts || []) { if (done.delete(n)) confirmed -= sizeOf(n); }
      for (const n of e.data?.bad_parts || []) { if (done.delete(n)) confirmed -= sizeOf(n); }
      if (!e.data?.missing_parts && !e.data?.bad_parts) throw e;
    }
  }
  throw new Error("Some parts could not be stored. Try again.");
}

async function putPart(sessionId, item, blob, signal, onState) {
  let url = item.url;
  for (let attempt = 0; ; attempt++) {
    await online();
    let problem;
    try {
      const res = await fetch(url, { method: "PUT", body: blob, signal, headers: { "content-type": "application/octet-stream" } });
      if (res.ok) return;
      problem = new Error(`Storage refused part ${item.part} (${res.status})`);
      if (res.status === 403) {
        // Part URLs last 15 minutes (e.g. the phone slept); ask for a fresh one for this part.
        const fresh = await api(`/v1/uploads/${sessionId}/parts`, { method: "POST", body: { parts: [item.part] } });
        url = fresh.urls[0].url;
      }
    } catch (e) {
      if (signal?.aborted || e.status) throw e; // paused by the user, or the server refused the session
      problem = e;
    }
    if (attempt >= 6) throw problem;
    // No fraction here: the bytes already confirmed by storage stay on screen while we retry.
    onState({ phase: "waiting",
      message: navigator.onLine ? "Connection hiccup, retrying" : "Offline. Will continue when you're back online" });
    await sleep(Math.min(30000, 1000 * 2 ** attempt));
  }
}
