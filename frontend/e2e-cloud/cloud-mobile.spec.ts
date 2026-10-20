import { expect, Page, test } from "@playwright/test";
import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Chrome-on-Android tests of the phone app (cloud/web) at 375 and 430 px against the local stack: the real control-plane
// Worker under wrangler dev, moto standing in for private R2, and a real `python -m cutcue.agent` process that the tests
// start and stop (so "Mac offline" and "reconnect" are real). Nothing reaches Cloudflare.
test.describe.configure({ mode: "serial" });

const TMP = path.join(__dirname, ".tmp");
type Stack = { url: string; agent_env: Record<string, string>; python: string; backend: string };

function stack(): Stack {
  const file = path.join(__dirname, ".stack.json");
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("stack state file missing");
}

let agent: ChildProcess | null = null;
let agentLog = "";
function startAgent() {
  const s = stack();
  agent = spawn(s.python, ["-m", "cutcue.agent"], { cwd: s.backend, env: { ...process.env, ...s.agent_env, NO_PROXY: "*", no_proxy: "*" } });
  agent.stdout?.on("data", (d) => (agentLog += d));
  agent.stderr?.on("data", (d) => (agentLog += d));
}
async function stopAgent() {
  if (!agent) return;
  const p = agent;
  agent = null;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await exited;
}
test.afterAll(async () => { await stopAgent(); });

const width = () => test.info().project.name.replace("android-", "");
async function shot(page: Page, name: string, mask: string[] = []) {
  const dir = path.join(__dirname, "..", "..", "docs", "cloud", "screenshots", test.info().project.name);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), mask: mask.map((m) => page.locator(m)) });
}
async function noSideScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]);
  expect(sw, "page must not scroll sideways").toBeLessThanOrEqual(iw);
}
function randomFile(name: string, bytes: number) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name);
  if (!fs.existsSync(file) || fs.statSync(file).size !== bytes) fs.writeFileSync(file, crypto.randomBytes(bytes));
  return file;
}
async function openNew(page: Page) {
  await expect(page.locator("details.new")).toBeVisible();
  if ((await page.locator("details.new").getAttribute("open")) === null) await page.locator("details.new summary").click();
  await expect(page.getByLabel("Project name")).toBeVisible();
}
async function newProject(page: Page, name: string) {
  await page.goto("/");
  await openNew(page);
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("install: manifest, icons, service worker and offline shell", async ({ page, browser }) => {
  await page.goto("/");
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ id: "/", start_url: "/#/", scope: "/", display: "standalone", name: "Menapoly Cue" });
  const pngs = manifest.icons.filter((i: { type: string }) => i.type === "image/png");
  expect(pngs.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  for (const i of manifest.icons) {
    const r = await page.request.get(i.src);
    expect(r.status(), i.src).toBe(200);
  }
  expect((await page.request.get("/")).headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  // A real service worker (the other tests block it so they can watch network traffic).
  const ctx = await browser.newContext({ ...test.info().project.use, serviceWorkers: "allow" });
  const p = await ctx.newPage();
  await p.goto("/");
  await expect(p.getByRole("heading", { name: "Menapoly Cue" })).toBeVisible();
  await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  await p.reload();
  expect(await p.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  // Offline: the cached app still opens and says what's wrong instead of a browser error page.
  await ctx.setOffline(true);
  await p.reload();
  await expect(p.getByRole("alert")).toContainText(/offline/i);
  await shot(p, "15-offline-launch");
  await ctx.close();
});

test("sign-in: owner gets in, anyone else is refused", async ({ page, browser }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link")).toHaveText(["Projects", "Ask Cue", "Inbox", "Settings"]);
  await expect(page.locator("#worker-pill")).toHaveText(/Mac (online|offline)/);
  await noSideScroll(page);
  await shot(page, "01-projects");
  const stranger = await browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { "x-dev-user": "stranger@example.test" } });
  const p2 = await stranger.newPage();
  await p2.goto("/");
  await expect(p2.getByRole("alert")).toHaveText("This account is not allowed in Menapoly Cue.");
  await shot(p2, "02-refused");
  await stranger.close();
});

test("projects: a half-typed name survives a reload; create opens the project", async ({ page }) => {
  await page.goto("/");
  await openNew(page);
  await page.getByLabel("Project name").fill(`Draft ${width()}`);
  await page.reload();
  await expect(page.getByLabel("Project name")).toHaveValue(`Draft ${width()}`);
  await page.getByLabel("Project name").fill(`Market Mocha ${width()}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Market Mocha ${width()}` })).toBeVisible();
  await expect(page.locator(".next")).toContainText("Upload footage to begin");
  await noSideScroll(page);
  await shot(page, "03-new-project");
});

test("upload: survives a dropped connection and a closed app", async ({ page }) => {
  const file = randomFile(`phone-clip-${width()}.mp4`, 20 * 1024 * 1024 + 12345); // 3 parts of 8 MiB
  await newProject(page, `Resume ${width()}`);
  const puts: number[] = [];
  let failNext = 1, block = false, tries2 = 0;
  await page.route(/\/menapoly-cue-media\/.*partNumber=/, async (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
    if (route.request().method() !== "PUT") return route.continue();
    if (n === 2) tries2++;
    if (block && n > 1) return route.abort("internetdisconnected");
    if (n === 2 && failNext-- > 0) return route.abort("connectionreset");
    puts.push(n);
    return route.continue();
  });
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.getByText(`phone-clip-${width()}.mp4 uploaded`)).toBeVisible({ timeout: 60_000 });
  expect(tries2).toBe(2); // the dropped part was retried by itself, once
  expect(puts.filter((n) => n === 2).length).toBe(1);

  const file2 = randomFile(`phone-clip-b-${width()}.mp4`, 20 * 1024 * 1024 + 999);
  puts.length = 0;
  block = true;
  await page.locator("#file-input").setInputFiles(file2);
  await expect.poll(() => puts.includes(1), { timeout: 60_000 }).toBe(true);
  await expect(page.locator(".upload .meta", { hasText: /hiccup|Offline/ })).toContainText("39%");
  await shot(page, "04-upload-interrupted");
  await page.reload();
  await expect(page.getByText("Unfinished uploads")).toBeVisible();
  await shot(page, "05-upload-resume");
  block = false;
  puts.length = 0;
  await page.locator("#file-input").setInputFiles(file2);
  await expect(page.getByText(`phone-clip-b-${width()}.mp4 uploaded`)).toBeVisible({ timeout: 60_000 });
  expect(puts.sort()).toEqual([2, 3]);
  await expect(page.getByText("Unfinished uploads")).toHaveCount(0);
});

test("Ask Cue: answers from real data, proposes, and only your approval acts", async ({ page }) => {
  await page.goto("/#/ask");
  await page.evaluate(() => sessionStorage.removeItem("cue-chat"));
  await page.reload();
  await expect(page.getByText("Built-in planner")).toBeVisible();
  await page.getByRole("button", { name: "What needs my attention?" }).click();
  await expect(page.locator(".msg.cue").last()).toContainText(/Nothing needs you right now|need your approval/);
  const name = `Spring Promo ${width()}`;
  await page.getByLabel("Message").fill(`New project ${name}`);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.locator(".msg.cue").last().locator(".action");
  await expect(card).toContainText(`Create project "${name}"`);
  await expect(card).toContainText("Waiting for you");
  await noSideScroll(page);
  await shot(page, "06-ask-proposal");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible(); // approval created it and opened it
  // A job proposal for a project without footage is refused in words, not guessed at.
  await page.getByRole("link", { name: "Ask Cue about this project" }).click();
  await page.getByLabel("Message").fill("suggest an edit");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.cue").last()).toContainText("has no finished video or audio upload yet");
  await shot(page, "07-ask-scoped");
});

test("remote edit: Mac offline, reconnect, review, approve, export, play, download", async ({ page }) => {
  const video = path.join(__dirname, ".fixtures", "market-mocha-interview.mp4");
  const name = `Market Mocha ${width()}`;
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(name) }).click();
  await page.locator("#file-input").setInputFiles(video);
  await expect(page.getByText("market-mocha-interview.mp4 uploaded")).toBeVisible({ timeout: 60_000 });
  const fileRow = page.locator(".row", { hasText: "market-mocha-interview.mp4" });
  await fileRow.getByRole("button", { name: "Suggest edit" }).click();
  await expect(page.getByText("Queued. It starts when your Mac reconnects.")).toBeVisible();
  await expect(page.locator(".next")).toContainText("Waiting for your Mac");
  const job = page.locator(".row.job").first();
  await expect(job).toContainText("Your Mac is offline. This starts when it reconnects.");
  await expect(job.locator(".bar")).toHaveCount(0); // no invented progress
  await shot(page, "08-mac-offline");

  startAgent();
  await expect(page.locator("#worker-pill")).toHaveText("Mac online", { timeout: 60_000 });
  await expect(page.locator(".next")).toContainText("ready for your review", { timeout: 180_000 });
  const review = page.locator("section", { has: page.getByRole("heading", { name: "Needs your review" }) });
  await expect(review.locator(".why")).toContainText(/Removes|pause|Rough/i); // the Mac's own summary of the edit
  await review.getByRole("button", { name: "Show clips" }).click();
  await expect(review.locator(".cliplist li").first()).toBeVisible();
  await noSideScroll(page);
  await shot(page, "09-review-edit");
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved. Choose a format to export.")).toBeVisible();

  const edits = page.locator("section", { has: page.getByRole("heading", { name: "Edits" }) });
  await edits.getByLabel(/Export format for edit/).selectOption("preview");
  await edits.getByRole("button", { name: "Export" }).click();
  const exportJob = page.locator(".row.job", { hasText: "Video export" }).first();
  await expect(exportJob).toBeVisible();
  for (let i = 0; i < 60 && !(await page.locator("section", { has: page.getByRole("heading", { name: "Finished videos" }) }).count()); i++) {
    if (await exportJob.getByText("Working on your Mac").isVisible().catch(() => false)) { await shot(page, "10-export-running"); break; }
    await page.waitForTimeout(500);
  }
  const finished = page.locator("section", { has: page.getByRole("heading", { name: "Finished videos" }) });
  await expect(finished).toBeVisible({ timeout: 240_000 });
  await expect(page.locator(".next")).toContainText("Your video is ready");
  await expect(finished.locator(".row").first()).toContainText("checksum verified");
  await shot(page, "11-video-ready");

  await finished.getByRole("button", { name: "Play" }).first().click();
  const player = page.locator("dialog video");
  await expect(player).toBeVisible();
  const src = await player.evaluate((v: HTMLVideoElement) => v.src);
  const media = await page.request.get(src, { headers: { range: "bytes=0-1023" } });
  expect([200, 206]).toContain(media.status());
  expect((await media.body()).subarray(4, 8).toString()).toBe("ftyp");
  if (!(await player.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'))))
    test.info().annotations.push({ type: "unverified", description: "H.264 playback: this Chromium build has no H.264 decoder (Chrome on Android has one)" });
  await shot(page, "12-preview");
  await page.getByRole("button", { name: "Close" }).click();

  let downloaded: Buffer = Buffer.alloc(0);
  await page.route(/response-content-disposition=attachment/, async (route) => {
    const real = await route.fetch();
    expect(real.status()).toBe(200);
    downloaded = await real.body();
    await route.fulfill({ status: 204 });
  });
  await finished.getByRole("button", { name: "Download" }).first().click();
  await expect.poll(() => downloaded.length, { timeout: 30_000 }).toBeGreaterThan(10_000);
  expect(downloaded.subarray(4, 8).toString()).toBe("ftyp");
  await page.unroute(/response-content-disposition=attachment/);
  await stopAgent();
  expect(agentLog).toMatch(/succeeded/);
  expect(agentLog).not.toMatch(/cqw_/);
});

test("session expiry: work pauses safely, sign in again returns you to the same place", async ({ page }) => {
  const file = randomFile(`expiry-${width()}.mp4`, 20 * 1024 * 1024 + 777);
  await newProject(page, `Expiry ${width()}`);
  const here = await page.evaluate(() => location.hash);
  const puts: number[] = [];
  let block = true;
  await page.route(/\/menapoly-cue-media\/.*partNumber=/, async (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
    if (route.request().method() !== "PUT") return route.continue();
    if (block && n > 1) return route.abort("connectionreset");
    puts.push(n);
    return route.continue();
  });
  await page.locator("#file-input").setInputFiles(file);
  await expect.poll(() => puts.includes(1), { timeout: 60_000 }).toBe(true);
  // Cloudflare Access ends the session: API calls now get its login redirect.
  await page.route("**/v1/**", (route) => route.fulfill({ status: 302, headers: { location: "https://menapoly.cloudflareaccess.com/cdn-cgi/access/login/cue" } }));
  await expect(page.getByRole("alert").filter({ hasText: "Your sign-in has expired" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".upload > .meta")).toContainText("Paused until you sign in again");
  await noSideScroll(page);
  await shot(page, "13-session-expired");
  // Signing in again (here: the session comes back) returns to the same project with the upload resumable.
  await page.unroute("**/v1/**");
  block = false;
  puts.length = 0;
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(new RegExp(here.replace("#", "#") + "$"));
  await expect(page.getByText("Unfinished uploads")).toBeVisible();
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.getByText(`expiry-${width()}.mp4 uploaded`)).toBeVisible({ timeout: 60_000 });
  expect(puts.sort()).toEqual([2, 3]);
});

test("offline: banner while the connection is gone, recovers by itself", async ({ page, context }) => {
  await page.goto("/");
  await context.setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event("offline")));
  await expect(page.locator(".banner", { hasText: "You're offline" })).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await shot(page, "14-offline");
  await context.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expect(page.locator(".banner", { hasText: "You're offline" })).toHaveCount(0);
});

test("inbox, settings and archive", async ({ page }) => {
  await page.goto("/#/inbox");
  await expect(page.locator(".note").first()).toBeVisible();
  await noSideScroll(page);
  await shot(page, "16-inbox");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Pilot safety" })).toBeVisible();
  await expect(page.locator(".facts")).toContainText("Client review links: off");
  await expect(page.locator(".facts")).toContainText("Cloud processing: off");
  await expect(page.locator(".facts")).toContainText("Text messages (SMS): off");
  await expect(page.getByRole("heading", { name: "This phone" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, "17-settings");
  await newProject(page, `Old test ${width()}`);
  await page.getByRole("button", { name: "Archive project" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByText("Archived")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Old test ${width()}`) })).toHaveCount(0);
});
