// Private object storage through the S3 API (Cloudflare R2 in production; any S3-compatible server locally).
// The Worker only signs short-lived URLs and calls control operations; media bytes go directly between the
// browser/Mac and storage, never through the Worker.
import { AwsClient } from "aws4fetch";
import { Env, HttpError } from "./util";

export const PART_URL_TTL = 15 * 60;   // seconds a presigned part/output upload URL stays valid
export const GET_URL_TTL = 10 * 60;    // seconds a presigned download/preview URL stays valid

function client(env: Env) {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    throw new HttpError(503, "Media storage is not configured.");
  return new AwsClient({ accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
                         service: "s3", region: env.S3_REGION || "auto" });
}

function objectUrl(env: Env, key: string, query: Record<string, string> = {}) {
  const url = new URL(`${env.S3_ENDPOINT!.replace(/\/$/, "")}/${env.S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => {
  const v = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
  return v == null ? null : unescape(v);
};

async function call(env: Env, method: string, url: URL, body?: string, headers: Record<string, string> = {}) {
  const res = await client(env).fetch(url.toString(), { method, body, headers });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new HttpError(502, `Storage error ${res.status}: ${tag(text, "Code") ?? text.slice(0, 120)}`);
  }
  return res;
}

export async function createMultipart(env: Env, key: string, contentType: string): Promise<string> {
  const res = await call(env, "POST", objectUrl(env, key, { uploads: "" }), undefined, { "content-type": contentType });
  const id = tag(await res.text(), "UploadId");
  if (!id) throw new HttpError(502, "Storage did not return an upload id");
  return id;
}

async function presign(env: Env, method: string, url: URL, ttl: number, headers: Record<string, string> = {}) {
  url.searchParams.set("X-Amz-Expires", String(ttl));
  const signed = await client(env).sign(url.toString(), { method, headers, aws: { signQuery: true } });
  return signed.url;
}

export function presignPart(env: Env, key: string, uploadId: string, partNumber: number) {
  return presign(env, "PUT", objectUrl(env, key, { partNumber: String(partNumber), uploadId }), PART_URL_TTL);
}

export function presignPut(env: Env, key: string) {
  return presign(env, "PUT", objectUrl(env, key), PART_URL_TTL);
}

export function presignGet(env: Env, key: string, downloadName?: string) {
  const q: Record<string, string> = {};
  if (downloadName) q["response-content-disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
  return presign(env, "GET", objectUrl(env, key, q), GET_URL_TTL);
}

export type Part = { number: number; etag: string; size: number };

export async function listParts(env: Env, key: string, uploadId: string): Promise<Part[] | null> {
  const parts: Part[] = [];
  let marker = "0";
  for (let page = 0; page < 20; page++) {
    const res = await call(env, "GET", objectUrl(env, key, { uploadId, "part-number-marker": marker, "max-parts": "1000" }));
    if (res.status === 404) return null;
    const xml = await res.text();
    for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      parts.push({ number: Number(tag(m[1], "PartNumber")), etag: tag(m[1], "ETag") ?? "", size: Number(tag(m[1], "Size")) });
    }
    if (tag(xml, "IsTruncated") !== "true") break;
    marker = tag(xml, "NextPartNumberMarker") ?? marker;
  }
  return parts.sort((a, b) => a.number - b.number);
}

export async function completeMultipart(env: Env, key: string, uploadId: string, parts: Part[]) {
  const xml = `<CompleteMultipartUpload>${parts.map((p) =>
    `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const res = await call(env, "POST", objectUrl(env, key, { uploadId }), xml, { "content-type": "application/xml" });
  const text = await res.text();
  if (res.status === 404 || /<Error>/.test(text)) throw new HttpError(409, `Storage could not complete the upload: ${tag(text, "Code") ?? "unknown"}`);
}

export async function abortMultipart(env: Env, key: string, uploadId: string) {
  await call(env, "DELETE", objectUrl(env, key, { uploadId }));
}

export async function head(env: Env, key: string): Promise<{ size: number } | null> {
  const res = await call(env, "HEAD", objectUrl(env, key));
  if (res.status === 404) return null;
  return { size: Number(res.headers.get("content-length") || 0) };
}

export async function deleteObject(env: Env, key: string) {
  await call(env, "DELETE", objectUrl(env, key));
}
