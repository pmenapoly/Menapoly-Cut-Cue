// Honest local persistence for the preview: what is saved where, and what to say when it isn't possible.
// Three different things, never mixed up:
//   1. Draft metadata (brief fields, notes, shapes, voice-note details) → localStorage with the rest of the demo state.
//   2. Media picked this session → an object URL in memory ("This session only"); gone after a refresh.
//   3. Recordings kept on this device → IndexedDB ("Saved on this device only"). Never uploaded anywhere.
// Phase 1 defines these helpers; the upload and recording screens that use them come in later phases.
import { STORAGE } from "./rooms.js";

const answer = (ok, reason, message, extra = {}) => ({ ok, reason, message, ...extra });

/** Can this browser record a voice note at all? Checked before asking for the microphone. */
export function micSupport(env = globalThis) {
  if (env.isSecureContext === false) return answer(false, "insecure", "Recording needs a secure (https) page. Type your note instead.");
  if (!env.navigator?.mediaDevices?.getUserMedia) return answer(false, "no-media-devices", "This browser can't record audio here. Type your note instead.");
  if (typeof env.MediaRecorder !== "function") return answer(false, "no-recorder", "This browser can't save recordings. Type your note instead.");
  return answer(true, null, "Recording is available. The microphone is requested only when you press Record.");
}

/** Maps a getUserMedia failure to a plain explanation. Nothing pretends to record after a failure. */
export function micError(err, env = globalThis) {
  const name = err?.name || "";
  const framed = (() => { try { return env.self !== env.top; } catch { return true; } })();
  if (name === "NotAllowedError" || name === "SecurityError") return framed
    ? answer(false, "blocked", "The microphone is blocked for this page (it may be inside a frame that doesn't allow it). Type your note instead.")
    : answer(false, "denied", "Microphone access was declined. You can allow it in the browser's site settings, or type your note instead.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return answer(false, "no-device", "No microphone was found. Type your note instead.");
  if (name === "NotReadableError" || name === "AbortError") return answer(false, "busy", "The microphone is in use by another app. Close it and try again, or type your note.");
  return answer(false, "unknown", "Recording couldn't start. Type your note instead.");
}

/** Asks for the microphone (only call this from a Record button press). Returns { ok, stream } or an explanation. */
export async function requestMicrophone(env = globalThis) {
  const support = micSupport(env);
  if (!support.ok) return support;
  try { return answer(true, null, "Recording", { stream: await env.navigator.mediaDevices.getUserMedia({ audio: true }) }); }
  catch (e) { return micError(e, env); }
}

/** Where an asset's bytes live and whether they can be played right now. */
export function mediaAvailability(asset, { sessionUrl = false, deviceBlob = null } = {}) {
  const storage = asset?.storage || (asset?.media ? "demo" : "none");
  const label = STORAGE[storage] || STORAGE.none;
  if (storage === "demo") return { storage, label, available: Boolean(asset.media), uploaded: false };
  if (storage === "session") return { storage, label, available: sessionUrl, uploaded: false,
    ...(sessionUrl ? {} : { missing: true, message: "This file was only kept for the session it was added in. Add it again to play it." }) };
  if (storage === "device") return { storage, label, available: deviceBlob === true, uploaded: false,
    ...(deviceBlob === false ? { missing: true, message: "This file is no longer saved on this device (browser data may have been cleared). Add it again." } : {}) };
  return { storage: "none", label: STORAGE.none, available: false, uploaded: false };
}

const QUOTA = (e) => e?.name === "QuotaExceededError" || e?.code === 22;

/**
 * Small IndexedDB store for recordings and files kept on this device. Every method resolves (never throws) with
 * { ok, reason, message }, so a full or blocked store becomes a plain message instead of a lost note.
 */
export function deviceStore(env = globalThis, name = "menapoly-cue-studio-media") {
  let db = null;
  const open = () => new Promise((resolve) => {
    if (db) return resolve(answer(true, null, "open"));
    if (!env.indexedDB?.open) return resolve(answer(false, "unavailable", "This browser can't keep files on the device here (private browsing or blocked storage). It stays for this session only."));
    let req;
    try { req = env.indexedDB.open(name, 1); } catch { return resolve(answer(false, "blocked", "Saving on this device is blocked by the browser. It stays for this session only.")); }
    req.onupgradeneeded = () => req.result.createObjectStore("blobs");
    req.onsuccess = () => { db = req.result; resolve(answer(true, null, "open")); };
    req.onerror = () => resolve(answer(false, "blocked", "Saving on this device is blocked by the browser. It stays for this session only."));
  });
  const run = (mode, fn) => open().then((o) => !o.ok ? o : new Promise((resolve) => {
    try {
      const tx = db.transaction("blobs", mode), r = fn(tx.objectStore("blobs"));
      tx.oncomplete = () => resolve(answer(true, null, "done", { value: r?.result ?? null }));
      tx.onabort = tx.onerror = () => resolve(QUOTA(tx.error) ? answer(false, "quota", "This device's browser storage is full. Delete older recordings, or keep this one for this session only.")
        : answer(false, "failed", "Couldn't save on this device. It stays for this session only."));
    } catch (e) { resolve(QUOTA(e) ? answer(false, "quota", "This device's browser storage is full.") : answer(false, "failed", "Couldn't use storage on this device.")); }
  }));
  return {
    open,
    put: (key, blob) => run("readwrite", (s) => s.put(blob, key)),
    get: (key) => run("readonly", (s) => s.get(key)).then((r) => r.ok && r.value == null ? answer(false, "missing", "That recording is no longer saved on this device.") : r),
    delete: (key) => run("readwrite", (s) => s.delete(key)),
  };
}
