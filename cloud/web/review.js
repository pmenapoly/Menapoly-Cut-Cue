// Client review page. The access token lives in the URL fragment (#rv_…), which browsers never send to servers or
// put in Referer headers. It grants exactly one video, until the link expires or is turned off.
const $ = document.getElementById("review");
const token = location.hash.slice(1);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function toast(message, kind = "ok") {
  const el = h("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}
async function call(method, body) {
  const res = await fetch(`/v1/public/review/${encodeURIComponent(token)}${body ? "/events" : ""}`, {
    method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    credentials: "omit", referrerPolicy: "no-referrer" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

let video;
async function load() {
  if (!/^rv_[A-Za-z0-9_-]{30,60}$/.test(token)) return fail("This review link isn't complete. Copy the whole link and try again.");
  let data;
  try { data = await call("GET"); } catch (e) { return fail(e.message); }
  const name = h("input", { id: "author", maxlength: "80", autocomplete: "name", required: true, value: safeGet("cue-review-name") });
  const note = h("textarea", { id: "note", rows: "3", maxlength: "4000", placeholder: "What should change? Mention a moment if it helps." });
  const stamp = h("label", { class: "check" }, h("input", { type: "checkbox", id: "stamp", checked: true }), " Attach the current video time");
  video = h("video", { src: data.video_url, controls: true, playsinline: true, preload: "metadata" });
  // Video URLs are short-lived; if one expires while the page is open, fetch a fresh one and keep the position.
  video.addEventListener("error", async () => {
    const at = video.currentTime;
    try { const fresh = await call("GET"); video.src = fresh.video_url; video.currentTime = at; } catch (e) { fail(e.message); }
  });
  const history = h("ul", { class: "rows" }, data.events.map(eventRow));
  const send = async (kind) => {
    if (!name.value.trim()) { name.focus(); return toast("Add your name first.", "err"); }
    if (kind !== "approved" && !note.value.trim()) { note.focus(); return toast("Write a note first.", "err"); }
    safeSet("cue-review-name", name.value.trim());
    const body = { kind, author: name.value.trim(), body: note.value.trim(),
                   at_seconds: document.getElementById("stamp").checked && kind !== "approved" ? Math.round(video.currentTime * 10) / 10 : null };
    try {
      await call("POST", body);
      history.append(eventRow({ ...body, created_at: Date.now() / 1000 }));
      note.value = "";
      toast(kind === "approved" ? "Thanks. Your approval was sent." : kind === "changes_requested" ? "Change request sent." : "Comment sent.");
    } catch (e) { toast(e.message, "err"); }
  };
  $.replaceChildren(
    h("h1", {}, data.project_name || "Video review"), h("p", { class: "muted" }, data.label),
    video,
    data.download_url ? h("a", { class: "btn", href: data.download_url }, "Download video") : null,
    h("section", { class: "card form" },
      h("label", { for: "author" }, "Your name"), name,
      h("label", { for: "note" }, "Note"), note, stamp,
      h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => send("approved") }, "Approve"),
        h("button", { class: "btn", type: "button", onclick: () => send("changes_requested") }, "Request changes"),
        h("button", { class: "btn", type: "button", onclick: () => send("comment") }, "Comment"))),
    h("section", { class: "card" }, h("h2", {}, "Feedback so far"), history),
    h("p", { class: "meta" }, `This link works until ${new Date(data.expires_at * 1000).toLocaleString()}.`));
}
function eventRow(e) {
  const label = { approved: "Approved", changes_requested: "Requested changes", comment: "Comment" }[e.kind] || e.kind;
  return h("li", { class: "row" }, h("div", { class: "grow" }, h("strong", {}, `${e.author} · ${label}`),
    e.body ? h("p", {}, e.body) : null, e.at_seconds != null ? h("span", { class: "meta" }, `at ${Number(e.at_seconds).toFixed(1)}s`) : null));
}
function fail(message) { $.replaceChildren(h("h1", {}, "Video review"), h("p", { role: "alert" }, message)); }
function safeGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
load();
