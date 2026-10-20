// Same-origin JSON API client. In production every request carries the Cloudflare Access session cookie.
// A lost session (Access redirect, or a 401 from the Worker) raises one "cue:session-expired" event so the app can pause
// work safely and offer to sign in again, instead of showing scattered errors.
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const EXPIRED = "Your sign-in has expired. Sign in again to continue.";

function expired() {
  dispatchEvent(new CustomEvent("cue:session-expired"));
  return new ApiError(401, EXPIRED, null);
}

export async function api(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res;
  try {
    // redirect: "manual": an expired Cloudflare Access session answers API calls with a redirect to its login page,
    // which fetch can't follow cross-origin; it shows up here as an opaque redirect.
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
                              credentials: "same-origin", redirect: "manual" });
  } catch {
    if (!navigator.onLine) dispatchEvent(new CustomEvent("cue:offline"));
    throw new ApiError(0, navigator.onLine ? "Can't reach Menapoly Cue right now. Check your connection and try again." : "You're offline.", null);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw expired();
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    if (type.includes("text/html")) throw expired(); // Access login page served in place of JSON
    throw new ApiError(res.status, `Unexpected response (${res.status})`, null);
  }
  const data = await res.json();
  if (res.status === 401) throw expired();
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data;
}
