import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";
import path from "node:path";

// Upload-first, Phase 2: uploading opens a draft Editing Room (no request, no editor, no rounds, no production
// notifications). Fictional people and files; files stay in the browser (IndexedDB or this session), nothing is uploaded.

const proj = () => test.info().project.name;
const MEDIA = path.join(__dirname, "..", "..", "studio-preview", "media");
const CLIP = path.join(MEDIA, "nw-launch-v1.webm"), CLIP2 = path.join(MEDIA, "nw-reel.webm");
async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
const svcCall = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(async ([fn, args]) => {
  const { svc } = await import("/js/" + "service.js");
  try { return { ok: true, value: await (svc as any)[fn as string](...(args as unknown[])) }; } catch (e: any) { return { ok: false, code: e.code, message: e.message }; }
}, [fn, args] as const);
const as = async (page: Page, uid: string) => { await page.evaluate(async (uid) => { const { svc } = await import("/js/" + "service.js"); svc.switchUser(uid); }, uid); };
const roomId = (page: Page) => page.url().split("#video-")[1];
const stage = (page: Page) => page.locator(".room-head [data-status]");
async function uploadVia(page: Page, files: string | string[] | { name: string; mimeType: string; buffer: Buffer }, { project, mode, title }: { project?: string; mode?: "together" | "separate"; title?: string } = {}) {
  await open(page, "studio");
  await page.getByRole("button", { name: "Upload & brief" }).click();
  await page.locator("#up-file").setInputFiles(files as any);
  if (project) await page.locator("#up-project").selectOption({ label: project });
  if (mode) await page.locator(`input[name=up-mode][value=${mode}]`).check();
  if (title) await page.locator("#up-title").fill(title);
}
const counts = async (page: Page) => ({
  requests: ((await svcCall(page, "requests")).value as any[]).length,
  videos: ((await svcCall(page, "videos")).value as any[]).length,
});

test.beforeEach(() => { test.skip(proj() === "android-360", "runs at 430 and 1440; the layout check below covers 360"); });

test("upload opens a draft room automatically: no request, editor, rounds or production notifications; a double tap makes one", async ({ page }) => {
  await open(page, "home");
  const before = await counts(page);
  await as(page, "u_admin"); const adminInbox = ((await svcCall(page, "notifications")).value as any[]).length; await as(page, "u_jordan");
  await uploadVia(page, CLIP, { title: "Roastery floor" });
  await page.locator("#up-go").dblclick();
  await expect(page).toHaveURL(/#video-v_/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Roastery floor");
  await expect(stage(page)).toHaveText("Uploaded");
  await expect(page.locator("[data-draft]")).toHaveText("Draft — not submitted");
  await expect(page.getByText("Northwind Roasters · Spring Launch Campaign")).toBeVisible();
  await expect(page.locator(".draft-player .vp")).toBeVisible(); // the footage plays in the dark stage
  await expect(page.locator("[data-storage=device]")).toHaveText(/Saved on this device only: not uploaded/);
  await expect(page.getByLabel("What happens next")).toContainText("no editing request, no editor and no revision rounds used");
  expect(await counts(page)).toEqual(before);
  const assets = (await svcCall(page, "assets", { ws: "ws_nw", q: "nw-launch-v1.webm" })).value as any[];
  expect(assets.length).toBe(1);
  const room = (await svcCall(page, "room", roomId(page))).value as any;
  expect(room).toMatchObject({ requestId: null, reviewId: null, stage: "Uploaded" });
  await as(page, "u_admin");
  expect(((await svcCall(page, "notifications")).value as any[]).length).toBe(adminInbox);
  const board = (await svcCall(page, "production")).value as any;
  expect(board.rows.some((r: any) => r.videoId === room.id)).toBe(false); // drafts never reach the production board
});

test("leave and come back: the same draft room from Studio, the project page and the Library, after a refresh", async ({ page }) => {
  await uploadVia(page, CLIP, { title: "Come back later" });
  await page.locator("#up-go").click();
  await expect(stage(page)).toHaveText("Uploaded");
  const rid = roomId(page);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Come back later");
  await expect(page.locator("[data-availability]")).toHaveText("Available"); // restored from this device
  await open(page, "studio");
  const fromStudio = page.getByLabel("Drafts, not submitted").locator(`[data-draft-room=${rid}] a`);
  await expect(fromStudio).toContainText("Draft");
  await fromStudio.click();
  await expect(page).toHaveURL(new RegExp(`#video-${rid}$`));
  await open(page, "project-p_launch");
  await page.getByLabel("Drafts, not submitted").locator(`[data-draft-room=${rid}] a`).click();
  await expect(page).toHaveURL(new RegExp(`#video-${rid}$`));
  await open(page, "library");
  const tile = page.locator(".tiles > div", { hasText: "nw-launch-v1.webm" });
  await expect(tile).toContainText("Draft · not submitted");
  await tile.getByRole("link", { name: "Continue preparing" }).click();
  await expect(page).toHaveURL(new RegExp(`#video-${rid}$`));
});

test("intentional uploads of the same footage into separate projects stay separate rooms", async ({ page }) => {
  await uploadVia(page, CLIP, { project: "Spring Launch Campaign" });
  await page.locator("#up-go").click(); await expect(stage(page)).toHaveText("Uploaded");
  const a = roomId(page);
  await uploadVia(page, CLIP, { project: "Brew Tips Reels" });
  await page.locator("#up-go").click(); await expect(page.locator(".room-head")).toContainText("Northwind Roasters · Brew Tips Reels");
  const b = roomId(page);
  expect(a).not.toBe(b);
  await open(page, "studio");
  await expect(page.getByLabel("Drafts, not submitted").locator("[data-draft-room]")).toHaveCount(2);
});

test("several files: one room with navigable related files, or one room per file when chosen; add a file later", async ({ page }) => {
  await uploadVia(page, [CLIP, CLIP2], { mode: "together", title: "Two angles" });
  await page.locator("#up-go").click();
  await expect(stage(page)).toHaveText("Uploaded");
  const strip = page.getByRole("group", { name: "Files in this room" });
  await expect(strip.getByRole("button")).toHaveCount(2);
  await expect(strip.getByRole("button", { name: /nw-launch-v1\.webm Main/ })).toHaveAttribute("aria-pressed", "true");
  await strip.getByRole("button", { name: /nw-reel\.webm/ }).click();
  await expect(strip.getByRole("button", { name: /nw-reel\.webm/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Source files").getByRole("button", { name: "Add a file" }).click();
  await page.locator("#up-file").setInputFiles({ name: "storefront.webm", mimeType: "video/webm", buffer: Buffer.alloc(4096) });
  await page.locator("#up-go").click();
  await expect(page.getByLabel("Source files")).toContainText("Source files (3)");
  // Separate rooms only when chosen
  const before = ((await svcCall(page, "drafts")).value as any[]).length, requests = ((await svcCall(page, "requests")).value as any[]).length;
  await uploadVia(page, [CLIP, CLIP2], { mode: "separate" });
  await page.locator("#up-go").click();
  await expect(stage(page)).toHaveText("Uploaded");
  expect(((await svcCall(page, "drafts")).value as any[]).length).toBe(before + 2);
  expect(((await svcCall(page, "requests")).value as any[]).length).toBe(requests); // uploads never create requests
});

test("Library upload: footage asks for its project and opens the room; library-only and unsupported files behave as before", async ({ page }) => {
  await open(page, "library");
  await page.locator("#lib-file").setInputFiles(CLIP);
  await expect(page.locator("#up-project")).toHaveValue("p_launch");
  await page.locator("#up-go").click();
  await expect(stage(page)).toHaveText("Uploaded");
  await open(page, "library");
  await page.locator("#lib-file").setInputFiles({ name: "library-only.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
  await page.locator("#up-project").selectOption({ label: "Library only (no Editing Room)" });
  await expect(page.locator("#up-go")).toHaveText("Add to the library");
  await page.locator("#up-go").click();
  await expect(page.getByText("library-only.mp4 added")).toBeVisible();
  await page.locator("#lib-file").setInputFiles({ name: "script.exe", mimeType: "application/x-msdownload", buffer: Buffer.alloc(10) });
  await expect(page.getByText("that file type isn't accepted")).toBeVisible();
});

test("refresh without device storage: the file is marked missing and can be added again (only the same file)", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }); });
  await uploadVia(page, CLIP);
  await page.locator("#up-go").click();
  await expect(page.locator(".toast.err", { hasText: "can't keep files on the device" })).toBeVisible();
  await expect(page.locator("[data-storage=session]")).toHaveText(/This session only/);
  await page.reload();
  await expect(page.locator("[data-availability]")).toHaveText("Missing");
  await expect(page.getByText("This file isn't on this device anymore")).toBeVisible();
  await page.locator("input[id^=again-]").first().setInputFiles(CLIP2); // a different file is refused
  await expect(page.locator(".toast.err", { hasText: "That's a different file" })).toBeVisible();
  await page.locator("input[id^=again-]").first().setInputFiles(CLIP);
  await expect(page.locator("[data-availability]")).toHaveText("Available");
  await expect(page.locator(".draft-player .vp")).toBeVisible();
});

test("storage failures and unplayable formats are explained, never hidden", async ({ page }) => {
  // Device storage full
  await page.addInitScript(() => { IDBObjectStore.prototype.put = function () { throw new DOMException("full", "QuotaExceededError"); }; });
  await uploadVia(page, CLIP);
  await page.locator("#up-go").click();
  await expect(page.locator(".toast.err", { hasText: "storage is full" })).toBeVisible();
  await expect(page.getByLabel("Source files")).toContainText("storage is full");
  // A file this browser can't decode
  await uploadVia(page, { name: "broken-camera.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
  await page.locator("#up-go").click();
  await expect(page.getByText("This browser can't play this format")).toBeVisible();
  // Demo data can't be saved in this browser: the room says so
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k: string, v: string) { if (k === "menapoly-cue-studio-demo") throw new DOMException("blocked", "SecurityError"); return set.call(this, k, v); }; });
  await page.getByLabel("Source files").getByRole("button", { name: "Add a file" }).click();
  await page.locator("#up-file").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(100) });
  await page.locator("#up-go").click();
  await expect(page.getByRole("alert").filter({ hasText: "blocks storage" })).toBeVisible();
});

test("draft visibility: other workspaces and editors can't see or open drafts; administrators can", async ({ page }) => {
  await uploadVia(page, CLIP, { title: "Private draft" });
  await page.locator("#up-go").click(); await expect(stage(page)).toHaveText("Uploaded");
  const rid = roomId(page);
  for (const uid of ["u_priya", "u_sam"]) {
    await as(page, uid);
    await open(page, "home");
    await open(page, `video-${rid}`);
    await expect(page.getByText("You don't have access to this")).toBeVisible();
    await open(page, "studio");
    await expect(page.getByLabel("Drafts, not submitted")).toHaveCount(0);
    expect(((await svcCall(page, "drafts")).value as any[]).length).toBe(0);
  }
  await open(page, "project-p_launch"); // Sam is assigned to this project, but drafts aren't production work
  await expect(page.getByLabel("Drafts, not submitted")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload & brief" })).toHaveCount(0);
  const queue = (await svcCall(page, "production")).value as any;
  expect(queue.rows.every((r: any) => r.videoId !== rid)).toBe(true);
  await as(page, "u_admin");
  await open(page, "studio");
  await expect(page.getByLabel("Drafts, not submitted")).toContainText("Private draft");
  const editors = ((await svcCall(page, "production")).value as any).editors;
  expect(editors.find((e: any) => e.id === "u_sam").open).toBe(2); // unchanged by the draft
});

test("request-first still works next to drafts, and the draft room passes axe", async ({ page }) => {
  await uploadVia(page, CLIP);
  await page.locator("#up-go").click(); await expect(stage(page)).toHaveText("Uploaded");
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(res.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  await open(page, "studio");
  await page.getByRole("button", { name: "Upload & brief" }).click();
  await page.locator("#up-file").setInputFiles([CLIP, CLIP2]);
  const sheetAxe = await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(sheetAxe.violations.map((x) => x.id)).toEqual([]);
  await page.keyboard.press("Escape");
  const r = (await svcCall(page, "createRequest", { projectId: "p_launch", key: "rf_after_draft", title: "Request-first still", brief: "A short cut" })).value as any;
  await open(page, `video-${r.videoId}`);
  await expect(page.locator(".room-head [data-status]")).toHaveText("Waiting to start"); // the existing Editing Room, unchanged
  await open(page, "video-v_launch");
  await expect(page.getByLabel("Revision rounds")).toContainText("1 of 3 used");
});

test("draft room layout at 360, 430 and 1440: no sideways scroll, controls 44 px, Maven reachable", async ({ page }) => {
  test.skip(proj() !== "android-430", "one sweep covers every width");
  await uploadVia(page, [CLIP, CLIP2], { mode: "together", title: "A very long draft title that should wrap neatly on a small phone screen" });
  await page.locator("#up-go").click(); await expect(stage(page)).toHaveText("Uploaded");
  for (const [w, hgt] of [[360, 780], [430, 932], [768, 1024], [1440, 900]] as const) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.reload(); await expect(stage(page)).toHaveText("Uploaded");
    const issues = await page.evaluate(() => {
      const out: string[] = [];
      if (document.scrollingElement!.scrollWidth > innerWidth) out.push(`sideways scroll ${document.scrollingElement!.scrollWidth}`);
      document.querySelectorAll<HTMLElement>("main *").forEach((el) => { const b = el.getBoundingClientRect();
        if (b.width && b.right > innerWidth + 1 && !el.closest(".file-strip")) out.push(`overflows: ${el.tagName}.${el.className}`.slice(0, 80)); });
      document.querySelectorAll<HTMLElement>("main button, main a.btn, main label.btn").forEach((el) => { if (el.offsetWidth && el.getBoundingClientRect().height < 44) out.push(`small control: ${el.textContent?.trim().slice(0, 30)}`); });
      if (/\b(null|undefined|NaN)\b/.test(document.querySelector("main")!.innerText)) out.push("printed null/undefined/NaN");
      const maven = document.querySelector<HTMLElement>(".maven-btn"); if (!maven || maven.getBoundingClientRect().height < 44) out.push("Maven launcher missing");
      return [...new Set(out)];
    });
    expect(issues, `draft room at ${w}px`).toEqual([]);
  }
});
