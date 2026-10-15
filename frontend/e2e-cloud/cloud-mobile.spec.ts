import { expect, Page, test } from "@playwright/test";
import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Phone-size tests of the cloud app against the local stack (see playwright.cloud.config.ts). The Mac agent is a real
// `python -m cutcue.agent` process the tests start and stop, so "Mac offline" and "reconnect" are real.
test.describe.configure({ mode: "serial" });

const SHOTS = path.join(__dirname, "..", "..", "docs", "cloud", "screenshots");
const TMP = path.join(__dirname, ".tmp");
type Stack = { url: string; agent_env: Record<string, string>; python: string; backend: string; work: string };

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

async function shot(page: Page, name: string, mask: string[] = []) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false, mask: mask.map((m) => page.locator(m)) });
}

async function newProject(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("New project").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

function randomFile(name: string, bytes: number) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name);
  if (!fs.existsSync(file) || fs.statSync(file).size !== bytes) fs.writeFileSync(file, crypto.randomBytes(bytes));
  return file;
}

test("sign-in: allowed people get in, others are refused", async ({ page, browser }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Menapoly Cue" })).toBeVisible();
  await expect(page.locator("#worker-pill")).toHaveText(/Mac (online|offline)/);
  await shot(page, "01-projects");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Signed in as owner@example.test (owner).")).toBeVisible();
  await expect(page.getByText(/Local development mode/)).toBeVisible();
  const stranger = await browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { "x-dev-user": "stranger@example.test" } });
  const p2 = await stranger.newPage();
  await p2.goto("/");
  await expect(p2.getByRole("alert")).toHaveText("This account is not allowed in Menapoly Cue.");
  await expect(p2.getByText("This account isn't on the list")).toBeVisible();
  await shot(p2, "02-refused");
  await stranger.close();
});

test("upload survives a dropped connection and a closed page", async ({ page }) => {
  const file = randomFile("phone-clip.mp4", 20 * 1024 * 1024 + 12345); // 3 parts of 8 MiB
  await newProject(page, "Resume test");
  const puts: number[] = [];
  let failNext = 1; // the first attempt at part 2 loses its connection
  let block = false;
  await page.route(/\/menapoly-cue-media\/.*partNumber=/, async (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
    if (route.request().method() !== "PUT") return route.continue();
    if (block && n > 1) return route.abort("internetdisconnected");
    if (n === 2 && failNext-- > 0) return route.abort("connectionreset");
    puts.push(n);
    return route.continue();
  });
  // 1) a dropped part is retried automatically
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.getByText("Connection hiccup, retrying")).toBeVisible();
  await expect(page.getByText("phone-clip.mp4 uploaded")).toBeVisible({ timeout: 60_000 });
  expect(puts.filter((n) => n === 2).length).toBe(1);

  // 2) the page is closed mid-upload; picking the same file again sends only the missing parts
  const file2 = randomFile("phone-clip-2.mp4", 20 * 1024 * 1024 + 999);
  puts.length = 0;
  block = true;
  await page.locator("#file-input").setInputFiles(file2);
  await expect.poll(() => puts.includes(1), { timeout: 60_000 }).toBe(true);
  // part 1 (8 of ~20 MiB) is confirmed; the others keep failing, and the screen says so with the measured share
  await expect(page.locator(".upload .meta", { hasText: /hiccup|Offline/ })).toContainText("39%");
  await shot(page, "03-upload-interrupted");
  await page.reload();
  await expect(page.getByText("Unfinished uploads")).toBeVisible();
  await expect(page.getByText(/phone-clip-2\.mp4 .*choose the same file again to continue/)).toBeVisible();
  await shot(page, "04-upload-resume-prompt");
  block = false;
  puts.length = 0;
  await page.locator("#file-input").setInputFiles(file2);
  await expect(page.getByText("phone-clip-2.mp4 uploaded")).toBeVisible({ timeout: 60_000 });
  expect(puts.sort()).toEqual([2, 3]); // part 1 was not sent again
  await expect(page.locator(".rows .name", { hasText: "phone-clip-2.mp4" })).toBeVisible();
  await expect(page.getByText("Unfinished uploads")).toHaveCount(0);
});

test("remote edit: offline Mac, reconnect, approve, export, preview, download, client review", async ({ page, context }) => {
  const video = path.join(__dirname, ".fixtures", "market-mocha-interview.mp4");
  await newProject(page, "Market Mocha");
  await page.locator("#file-input").setInputFiles(video);
  await expect(page.getByText("market-mocha-interview.mp4 uploaded")).toBeVisible({ timeout: 60_000 });
  const fileRow = page.locator(".row", { hasText: "market-mocha-interview.mp4" });
  await expect(fileRow).toBeVisible();

  // No agent running: the job waits and says so honestly.
  await fileRow.getByRole("button", { name: "Suggest edit" }).click();
  const job = page.locator(".row.job").first();
  await expect(job.getByText("Waiting for your Mac")).toBeVisible();
  await expect(job.getByText("Your Mac is offline. This starts when it reconnects.")).toBeVisible();
  await expect(page.locator("#worker-pill")).toHaveText("Mac offline");
  await expect(job.locator(".bar")).toHaveCount(0); // no invented progress
  await shot(page, "05-mac-offline");

  // The Mac comes back: the queued job runs without anyone resubmitting it.
  startAgent();
  await expect(page.locator("#worker-pill")).toHaveText("Mac online", { timeout: 60_000 });
  await expect(page.getByText(/Edit 1: .*Needs your approval/)).toBeVisible({ timeout: 180_000 });
  await expect(page.locator(".row.job", { hasText: "Suggested edit" }).getByText("Done")).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".cliplist li").first()).toBeVisible();
  await shot(page, "06-edit-needs-approval");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved. You can export it now.")).toBeVisible();

  await page.getByLabel("Export format for edit 1").selectOption("preview");
  await page.getByRole("button", { name: "Export" }).click();
  const exportJob = page.locator(".row.job", { hasText: "Video export" });
  await expect(exportJob).toBeVisible();
  await expect(exportJob.getByText(/Working on your Mac|Starting on your Mac|Done/)).toBeVisible({ timeout: 60_000 });
  if (await exportJob.getByText("Working on your Mac").isVisible()) await shot(page, "07-export-running");
  await expect(exportJob.getByText("Done")).toBeVisible({ timeout: 240_000 });
  const finished = page.locator("section", { has: page.getByRole("heading", { name: "Finished videos" }) }).locator(".row").first();
  await expect(finished).toContainText("checksum verified");
  await shot(page, "08-finished-video");

  // Preview plays straight from private storage via a short-lived URL.
  await finished.getByRole("button", { name: "Play" }).click();
  const player = page.locator("dialog video");
  await expect(player).toBeVisible();
  const src = await player.evaluate((v: HTMLVideoElement) => v.src);
  const media = await page.request.get(src, { headers: { range: "bytes=0-1023" } });
  expect([200, 206]).toContain(media.status()); // the short-lived private URL serves the real file
  expect((await media.body()).subarray(4, 8).toString()).toBe("ftyp"); // an MP4 container
  if (await player.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'))) {
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(await player.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(1);
  } else {
    // Open-source Chromium (used here) has no H.264 decoder; phone Safari/Chrome do. Recorded, not faked.
    test.info().annotations.push({ type: "unverified", description: "in-browser H.264 playback: this Chromium build has no H.264 codec" });
  }
  await shot(page, "09-preview");
  await page.getByRole("button", { name: "Close" }).click();

  // Download: a signed, short-lived storage URL asking for an attachment. R2 honours that parameter and the phone saves
  // the file; moto ignores it, so the test fetches the real stored bytes itself and answers the tap with 204 (no navigation).
  let downloaded: Buffer = Buffer.alloc(0);
  await page.route(/response-content-disposition=attachment/, async (route) => {
    const real = await route.fetch();
    expect(real.status()).toBe(200);
    downloaded = await real.body();
    await route.fulfill({ status: 204 });
  });
  await finished.getByRole("button", { name: "Download" }).click();
  await expect.poll(() => downloaded.length, { timeout: 30_000 }).toBeGreaterThan(10_000);
  expect(downloaded.subarray(4, 8).toString()).toBe("ftyp");
  await page.unroute(/response-content-disposition=attachment/);

  // Client review link
  await expect(finished).toBeVisible();
  await finished.getByRole("button", { name: "Share for review" }).click();
  await page.getByLabel("Expires after").selectOption("24");
  await page.getByRole("button", { name: "Create link" }).click();
  const link = await page.getByLabel("Review link").inputValue();
  expect(link).toMatch(/\/review\.html#rv_[A-Za-z0-9_-]{40,}$/);
  await shot(page, "10-share-link", ["input.copy"]);
  await page.getByRole("button", { name: "Close" }).click();

  const client = await context.browser()!.newContext({ ...test.info().project.use });
  const review = await client.newPage();
  await review.goto(link);
  await expect(review.getByRole("heading", { name: "Market Mocha" })).toBeVisible();
  const reviewSrc = await review.locator("video").evaluate((v: HTMLVideoElement) => v.src);
  expect([200, 206]).toContain((await review.request.get(reviewSrc, { headers: { range: "bytes=0-15" } })).status());
  await review.getByLabel("Your name").fill("Dana (client)");
  await review.getByLabel("Note").fill("Please tighten the opening.");
  await review.getByRole("button", { name: "Request changes" }).click();
  await expect(review.getByText("Change request sent.")).toBeVisible();
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(review.getByText("Thanks. Your approval was sent.")).toBeVisible();
  await shot(review, "11-client-review");
  await client.close();

  await page.reload();
  const fb = page.locator("section", { has: page.getByRole("heading", { name: "Client feedback" }) });
  await expect(fb.getByText("Please tighten the opening.")).toBeVisible();
  await expect(fb.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Inbox" }).click();
  // Review events reach the inbox through the queue, so allow for delivery delay.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Dana (client) approved Market Mocha")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText(/Suggested edit ready in Market Mocha/)).toBeVisible();
  await shot(page, "12-inbox");

  // Turning the link off works immediately.
  await page.goBack();
  await page.locator("section", { has: page.getByRole("heading", { name: "Review links" }) }).getByRole("button", { name: "Turn off" }).click();
  const late = await (await page.request.get(`/v1/public/review/${link.split("#")[1]}`)).status();
  expect(late).toBe(410);

  await stopAgent();
  expect(agentLog).toMatch(/succeeded/);
  expect(agentLog).not.toMatch(/cqw_/); // the worker token never appears in logs
});

test("settings: Mac workers and costs, honest about what is measured", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Mac workers" })).toBeVisible();
  await expect(page.locator(".row", { hasText: "Local Mac" })).toBeVisible();
  await expect(page.getByText(/Costs for \d{4}-\d{2}/)).toBeVisible();
  await expect(page.getByText("No recorded spending this month.")).toBeVisible();
  await expect(page.getByText("Cloud processing: off.")).toBeVisible();
  await page.getByLabel("Add a Mac").fill("Second Mac");
  await page.getByRole("button", { name: "Create worker token" }).click();
  await expect(page.getByText("It won't be shown again.")).toBeVisible();
  await shot(page, "13-settings", ["input.copy"]);
  // PWA pieces are served (installability is checked by the browser on a real phone).
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  const sw = await page.request.get("/sw.js");
  expect(await sw.text()).toContain('url.pathname.startsWith("/v1/")');
  const index = await page.request.get("/");
  expect(index.headers()["content-security-policy"] || "").toContain("frame-ancestors 'none'");
});
