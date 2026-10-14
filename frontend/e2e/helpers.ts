import { APIRequestContext, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const fixtures = () => fs.readFileSync(path.join(__dirname, ".fixtures-path"), "utf8").trim();
export const fixture = (name: string) => path.join(fixtures(), name);

/** Upload through the real chunked upload API. */
export async function apiUpload(request: APIRequestContext, pid: string, file: string) {
  const data = fs.readFileSync(file);
  const up = await (await request.post(`/api/projects/${pid}/uploads`, { data: { filename: path.basename(file), size: data.length } })).json();
  const chunk = 4 * 1024 * 1024;
  for (let o = 0; o < data.length; o += chunk) {
    const r = await request.put(`/api/projects/${pid}/uploads/${up.id}?offset=${o}`, { data: data.subarray(o, o + chunk), headers: { "Content-Type": "application/octet-stream" } });
    expect(r.ok()).toBeTruthy();
  }
  return (await request.post(`/api/projects/${pid}/uploads/${up.id}/complete`)).json();
}

export async function waitIdle(request: APIRequestContext, pid: string, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const jobs = await (await request.get(`/api/projects/${pid}/jobs`)).json();
    if (!jobs.some((j: { status: string }) => j.status === "queued" || j.status === "running")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("jobs did not finish");
}

/** A project with the two-speaker WAV podcast, brief, and an approved auto-edit (no render wait). */
export async function projectWithEdit(request: APIRequestContext, name: string) {
  const p = await (await request.post("/api/projects", { data: { name } })).json();
  const asset = await apiUpload(request, p.id, fixture("market-mocha-podcast.wav"));
  await apiUpload(request, p.id, fixture("market-mocha-brief.txt"));
  await waitIdle(request, p.id);
  const proposal = await (await request.post(`/api/projects/${p.id}/auto-edit`, { data: { asset_id: asset.id } })).json();
  await request.post(`/api/projects/${p.id}/proposals/${proposal.id}/approve`);
  const seqs = await (await request.get(`/api/projects/${p.id}/sequences`)).json();
  return { pid: p.id as string, assetId: asset.id as string, seq: seqs[0] };
}

export async function shot(page: Page, name: string) {
  const dir = path.join(__dirname, "..", "..", "docs", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 1024;
