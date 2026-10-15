// Same-origin JSON API client. In production every request carries the Cloudflare Access session cookie.
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

export async function api(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, navigator.onLine ? "Can't reach Menapoly Cue right now." : "You're offline.", null);
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    // Cloudflare Access answers an expired session with its login page, not JSON.
    if (res.redirected || type.includes("text/html")) throw new ApiError(401, "Your sign-in expired. Reload the page to sign in again.", null);
    throw new ApiError(res.status, `Unexpected response (${res.status})`, null);
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data;
}
