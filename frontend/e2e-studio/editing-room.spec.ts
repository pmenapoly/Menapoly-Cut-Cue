import { expect, Page, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Editing Room, Project Workspace, Home direction and Maven (fictional data, local only). Fresh demo data per test.
const proj = () => test.info().project.name;
const phone = () => proj().startsWith("android");
async function shot(page: Page, name: string) {
  const dir = path.join(__dirname, "..", "..", "docs", "studio", "screenshots", proj());
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}
async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
async function asRole(page: Page, userId: string) {
  await open(page, "settings");
  await page.locator("#role-select").selectOption(userId);
  await expect(page.locator(".role-chip")).toBeVisible();
}
async function noSideScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]);
  expect(sw, "page must not scroll sideways").toBeLessThanOrEqual(iw);
}
const tab = (page: Page, name: RegExp | string) => page.getByRole("tablist", { name: "Editing Room" }).getByRole("tab", { name });
const status = (page: Page) => page.locator(".room-head [data-status]");

const requests: string[] = [];
test.beforeEach(async ({ page }) => { requests.length = 0; page.on("request", (r) => requests.push(r.url())); });

test("project workspace → video → Editing Room, and back", async ({ page }) => {
  await open(page, "studio");
  await page.locator("a.pcard", { hasText: "Spring Launch Campaign" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch Campaign");
  for (const s of ["Videos (1)", "Editing requests", "Collaborators", "Files"]) await expect(page.getByRole("heading", { name: s })).toBeVisible();
  await expect(page.getByRole("list", { name: "Project progress" })).toBeVisible();
  await shot(page, "20-project-workspace");
  await page.locator(".tile", { hasText: "Spring Launch hero spot" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch hero spot");
  await expect(page.locator(".room-head")).toContainText("Northwind Roasters · Spring Launch Campaign");
  await expect(status(page)).toHaveText("Ready for review");
  await expect(page.locator(".room-head")).toContainText("Editor: Sam Rivera");
  await noSideScroll(page);
  await shot(page, "21-editing-room");
  await page.locator(".room-head .back-link").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch Campaign");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch hero spot");
});

test("media cards open the Editing Room (Home uploads, Review list, old links)", async ({ page }) => {
  await open(page, "home");
  await page.locator(".tile", { hasText: "brew-tips-reel-01.mp4" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Brew Tips — reel 01");
  await open(page, "review");
  await page.locator(".tile", { hasText: "Spring Launch hero spot" }).click();
  await expect(page).toHaveURL(/#video-v_launch$/);
  await page.goto("/#review-rv_launch");
  await expect(page).toHaveURL(/#video-v_launch$/);
  await page.goto("/#asset-a_reel");
  await expect(page).toHaveURL(/#video-v_reel$/);
});

test("player: play, pause, speed, volume, mute, full screen, versions, original comparison, transcript", async ({ page }) => {
  await open(page, "video-v_launch");
  const v = page.locator(".vp video");
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => v.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await page.getByRole("button", { name: "Pause" }).click();
  expect(await v.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await page.getByLabel("Playback speed").selectOption("1.5");
  expect(await v.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1.5);
  await page.getByLabel("Volume").fill("0.3");
  expect(await v.evaluate((el: HTMLVideoElement) => Math.round(el.volume * 10) / 10)).toBe(0.3);
  await page.getByRole("button", { name: "Mute" }).click();
  expect(await v.evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect.poll(async () => (await page.evaluate(() => Boolean(document.fullscreenElement))) || (await page.locator(".toast", { hasText: "Full screen" }).count()) > 0).toBe(true);
  if (await page.evaluate(() => Boolean(document.fullscreenElement))) await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".vp-time")).toContainText("0:12.0");
  await page.getByLabel("Version", { exact: true }).selectOption({ label: "Version 1" });
  await expect.poll(() => v.evaluate((el: HTMLVideoElement) => el.currentSrc)).toMatch(/nw-launch-v1\.(webm|mp4)$/);
  await page.getByLabel("Version", { exact: true }).selectOption({ label: "Version 2 (latest)" });
  await expect.poll(() => v.evaluate((el: HTMLVideoElement) => el.currentSrc)).toMatch(/nw-launch-v2\./);
  await page.getByRole("button", { name: "Compare versions" }).click();
  await expect(page.getByRole("dialog").locator("video")).toHaveCount(2);
  await expect(page.getByRole("dialog")).toContainText("First assembly (original)");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Transcript" }).click();
  await expect(page.getByRole("dialog")).toContainText("No transcript for this video"); // never invented
});

test("comments: frame annotation, reply, assign, resolve and reopen; version-linked; persists", async ({ page }) => {
  await asRole(page, "u_admin");
  await open(page, "video-v_launch");
  await tab(page, /Comments/).click();
  await page.locator(".room-panel .btn.primary", { hasText: "Leave feedback at" }).click();
  await page.getByRole("button", { name: "Box" }).click();
  const c = await page.locator(".vp-draw").boundingBox();
  await page.mouse.move(c!.x + c!.width * 0.2, c!.y + c!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(c!.x + c!.width * 0.6, c!.y + c!.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".composer-card")).toContainText("area marked");
  await page.getByLabel("Comment", { exact: true }).fill("Make the logo larger here");
  await shot(page, "22-annotate");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const note = page.locator(".note", { hasText: "Make the logo larger here" });
  await expect(note).toBeVisible();
  await expect(note.getByText("marked")).toBeVisible();
  await expect(note.getByText("v2", { exact: true })).toBeVisible();
  await expect(page.locator(".vp-pin")).toHaveCount(2);
  await note.getByLabel(/Reply to/).fill("On it");
  await note.getByRole("button", { name: "Reply" }).click();
  await page.locator(".note", { hasText: "Make the logo larger here" }).getByLabel("Assign this feedback").selectOption({ label: "Sam Rivera" });
  await expect(page.locator(".note", { hasText: "Make the logo larger here" })).toContainText("For Sam Rivera");
  await page.locator(".note", { hasText: "Make the logo larger here" }).getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".note", { hasText: "Make the logo larger here" })).toHaveCount(0); // moved out of "Open"
  await page.getByRole("button", { name: "Resolved", exact: true }).click();
  await page.locator(".note", { hasText: "Make the logo larger here" }).getByRole("button", { name: "Reopen" }).click();
  await expect(page.locator(".toast", { hasText: "Reopened" })).toBeVisible();
  await page.reload();
  await tab(page, /Comments/).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".note", { hasText: "Make the logo larger here" })).toContainText("On it");
  // version-linked: v1 shows its own comment, not v2's
  await page.getByLabel("Version", { exact: true }).selectOption({ label: "Version 1" });
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".note", { hasText: "Title feels heavy" })).toBeVisible();
  await expect(page.locator(".note", { hasText: "Make the logo larger here" })).toHaveCount(0);
  // assigned to Sam → shows under his "Assigned to me"
  await asRole(page, "u_sam");
  await open(page, "video-v_launch");
  await tab(page, /Comments/).click();
  await page.getByRole("button", { name: "Assigned to me" }).click();
  await expect(page.locator(".note", { hasText: "Make the logo larger here" })).toBeVisible();
});

test("checklist: clients follow and comment; the assigned editor ticks tasks", async ({ page }) => {
  await open(page, "video-v_launch");
  await tab(page, "Instructions").click();
  await expect(page.getByRole("heading", { name: "The brief" })).toBeVisible();
  for (const s of ["Before editing", "Video and sound", "Captions and graphics", "Final checks"]) await expect(page.getByRole("heading", { name: s })).toBeVisible();
  const task = page.locator(".task", { hasText: "Spell-check titles and captions" });
  await expect(task.getByRole("checkbox")).toBeDisabled();
  await expect(page.getByText("The editing team ticks these off")).toBeVisible();
  await expect(page.locator(".task", { hasText: "Keep the founder line" })).toContainText("source 02:14:05 · output 00:00:08");
  await task.getByRole("button", { name: "Add note" }).click();
  await task.getByLabel(/Note on/).fill("Please check the product name spelling");
  await task.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".task", { hasText: "Spell-check titles and captions" })).toContainText("Please check the product name spelling");
  await expect(page.locator(".task", { hasText: "Spell-check titles and captions" }).getByRole("checkbox")).not.toBeChecked();
  await asRole(page, "u_sam");
  await open(page, "video-v_launch");
  await tab(page, "Instructions").click();
  await expect(page.getByText("5 of 9 done").first()).toBeVisible();
  await page.locator(".task", { hasText: "Spell-check titles and captions" }).getByRole("checkbox").check();
  await expect(page.getByText("6 of 9 done").first()).toBeVisible();
  await page.getByLabel("Only my tasks").check();
  await expect(page.locator(".task", { hasText: "Captions on the vertical cut-downs" })).toHaveCount(0); // Mika's task
  await tab(page, "Activity").click();
  await expect(page.locator(".room-panel")).toContainText("Completed task: Spell-check titles and captions");
  await shot(page, "23-checklist-editor");
});

test("approvals: request changes needs a note; editor submits; client approves; history recorded", async ({ page }) => {
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("button", { name: "Send to the editor" }).click();
  await expect(page.getByText("Say what should change")).toBeVisible();
  await page.getByLabel("What should change?").fill("Hold the bag shot longer");
  await page.getByRole("button", { name: "Send to the editor" }).click();
  await expect(status(page)).toHaveText("Changes requested");
  await asRole(page, "u_sam");
  await open(page, "video-v_launch");
  await expect(page.getByRole("button", { name: "Approve video" })).toHaveCount(0); // editors never approve
  await page.getByLabel("Submit a new version").fill("Longer bag shot");
  await page.getByRole("button", { name: "Upload new version" }).click();
  await expect(status(page)).toHaveText("Ready for review");
  await expect(page.getByLabel("Version", { exact: true })).toContainText("Version 3 (latest)");
  await asRole(page, "u_jordan");
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "Approve video" }).click();
  await expect(status(page)).toHaveText("Approved");
  await expect(page.getByRole("heading", { name: "What's next" })).toBeVisible();
  await tab(page, /Versions/).click();
  await expect(page.locator(".room-panel")).toContainText("approved version 3");
  await expect(page.locator(".room-panel")).toContainText("requested changes: Hold the bag shot longer");
  await shot(page, "24-approved-whats-next");
});

test("templates: made from a video without client details, listed, and reused in a request", async ({ page }) => {
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("dialog").locator("[data-action=template]").click();
  await page.getByLabel("Template name").fill("Launch hero formula");
  await expect(page.getByRole("dialog")).toContainText("Never saved: footage, files, comments");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.locator(".toast", { hasText: "Template saved" })).toBeVisible();
  await open(page, "studio");
  await page.getByRole("tab", { name: "Templates" }).click();
  const card = page.locator("article.card", { hasText: "Launch hero formula" });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("Northwind");
  await expect(card).not.toContainText("Spring Launch Campaign");
  await shot(page, "25-templates");
  await card.getByRole("button", { name: "Use for a new request" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New editing request");
  await expect(page.getByLabel("Brief")).toHaveValue(/Look: Slow push-ins/);
  await expect(page.getByLabel("Start from a template")).toHaveValue(/tpl_/);
  // other workspaces never see it
  await asRole(page, "u_priya");
  await open(page, "studio");
  await page.getByRole("tab", { name: "Templates" }).click();
  await expect(page.getByText("Launch hero formula")).toHaveCount(0);
});

test("contextual actions follow status and role; unavailable ones explain why", async ({ page }) => {
  await open(page, "video-v_reel"); // approved
  await expect(page.getByRole("heading", { name: "What's next" })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  const d = page.getByRole("dialog");
  for (const k of ["cue", "another", "translate", "library", "social", "feed", "link", "template", "download"]) await expect(d.locator(`[data-action=${k}]`)).toBeVisible();
  await expect(d.locator("[data-action=link]")).toBeDisabled();
  await expect(d.locator("[data-action=link]")).toContainText("Not available in the preview");
  await expect(d.locator("[data-action=download]")).toBeDisabled();
  await shot(page, "26-actions");
  await d.locator("[data-action=translate]").click();
  await expect(page.getByRole("dialog")).toContainText("Automatic translation isn't available yet");
  await page.getByRole("button", { name: "Request translated captions" }).click();
  await expect(page.locator(".toast", { hasText: "Spanish captions for Brew Tips" })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("dialog").locator("[data-action=feed]").click();
  await page.getByRole("button", { name: "Add to feed", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Added to the feed" })).toBeVisible();
  // not approved yet → sharing actions are disabled with a reason
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("dialog").locator("[data-action=social]")).toBeDisabled();
  await expect(page.getByRole("dialog").locator("[data-action=social]")).toContainText("Available once the video is approved");
  // editors only see what they're allowed to do
  await asRole(page, "u_sam");
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "More actions" }).click();
  for (const k of ["social", "feed", "library", "another", "translate"]) await expect(page.getByRole("dialog").locator(`[data-action=${k}]`)).toHaveCount(0);
  await expect(page.getByRole("dialog").locator("[data-action=template]")).toBeVisible();
});

test("role and workspace isolation in the Editing Room", async ({ page }) => {
  await asRole(page, "u_priya");
  await open(page, "video-v_launch");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await open(page, "video-v_pod");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Harborline Talks — Ep. 12");
  await expect(status(page)).toHaveText("Waiting to start");
  await expect(page.getByLabel("Version", { exact: true })).toContainText("Original recording");
  await asRole(page, "u_mika");
  await open(page, "video-v_launch");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await open(page, "video-v_reel");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Brew Tips — reel 01");
});

test("Android layout: video fits, tabs reachable, no clipped text or sideways scroll", async ({ page }) => {
  for (const t of ["video-v_launch", "video-v_reel", "project-p_launch", "home"]) {
    await open(page, t);
    await noSideScroll(page);
    if (t.startsWith("video")) {
      const [vw, iw] = await page.evaluate(() => [document.querySelector(".vp")!.getBoundingClientRect().right, window.innerWidth]);
      expect(vw).toBeLessThanOrEqual(iw);
      for (const name of ["Instructions", /Comments/, /Versions/, "Files", "Activity"]) {
        const b = await tab(page, name).boundingBox();
        expect(b!.x + b!.width, `tab ${name} must be fully on screen`).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
      }
      const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".room-head h1, .room-head p, .chip, .tab, .btn")]
        .filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.textContent));
      expect(clipped).toEqual([]);
    }
  }
  if (phone()) await expect(page.locator(".bar")).toBeVisible();
});

test("Maven: opens over the room without losing place; answers; changes need approval", async ({ page }) => {
  await open(page, "video-v_launch");
  await tab(page, /Versions/).click();
  await page.locator(".vp-track").click({ position: { x: 40, y: 10 } });
  const before = await page.locator(".vp video").evaluate((el: HTMLVideoElement) => el.currentTime);
  await page.getByRole("button", { name: /Ask Maven/ }).click();
  const m = page.getByRole("dialog", { name: "Maven · this video" });
  for (const p of ["Summarize this video", "Suggest short clips", "Write a social caption", "Explain the editing instructions",
    "Help me request changes", "Suggest a new version", "Turn this video into a content idea"]) await expect(m.getByRole("button", { name: p })).toBeVisible();
  await m.getByRole("button", { name: "Summarize this video" }).click();
  await expect(m.locator(".msg.cue").last()).toContainText("Spring Launch hero spot");
  await expect(m.locator(".msg.cue").last()).toContainText("no transcript");
  await m.getByRole("button", { name: "Help me request changes" }).click();
  await expect(m.locator(".proposal").last()).toContainText("Waiting for you");
  await expect(status(page)).toHaveText("Ready for review"); // nothing changed yet
  await shot(page, "27-maven");
  await m.getByRole("button", { name: "Close" }).click();
  expect(await page.locator(".vp video").evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(before, 1);
  await expect(tab(page, /Versions/)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /Ask Maven/ }).click();
  await page.getByRole("dialog", { name: "Maven · this video" }).getByRole("button", { name: "Help me request changes" }).click();
  await page.getByRole("dialog", { name: "Maven · this video" }).locator(".proposal").last().getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog", { name: "Maven · this video" }).locator(".proposal").last()).toContainText("Done");
  await page.getByRole("dialog", { name: "Maven · this video" }).getByRole("button", { name: "Close" }).click();
  await expect(status(page)).toHaveText("Changes requested");
  await expect(tab(page, /Versions/)).toHaveAttribute("aria-selected", "true"); // place kept after the change
  // the launcher is on every screen
  for (const t of ["home", "studio", "library", "settings"]) { await open(page, t); await expect(page.getByRole("button", { name: /Ask Maven/ })).toBeVisible(); }
});

test("Home: announcements dismiss, 14-day spotlight, upload filters", async ({ page }) => {
  await open(page, "home");
  await expect(page.getByRole("tab", { name: "Coaching" })).toHaveCount(0);
  const ann = page.getByRole("region", { name: "Announcements" }).or(page.locator("section[aria-label=Announcements]"));
  await expect(ann).toContainText("New tutorial: giving frame-accurate feedback");
  await page.getByRole("button", { name: "Dismiss: New tutorial: giving frame-accurate feedback" }).click();
  await expect(page.getByText("New tutorial: giving frame-accurate feedback")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("New tutorial: giving frame-accurate feedback")).toHaveCount(0);
  const spot = page.locator(".spotlight");
  await expect(spot).toContainText("Write for the question, not the keyword"); // the entry whose 14-day window is today
  await expect(spot).toContainText(/changes every 14 days/i);
  await expect(page.getByText("Draft: video trends for 2027")).toHaveCount(0); // unapproved never shows
  await page.getByRole("button", { name: "My uploads" }).click();
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.getByRole("button", { name: "Others" }).click();
  await page.getByLabel("Uploaded by").selectOption({ label: "Sam Rivera" });
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.getByRole("button", { name: "All uploads" }).click();
  await page.getByLabel("Uploaded by").selectOption({ label: "Anyone" });
  await expect(page.locator(".tile")).toHaveCount(5);
  await noSideScroll(page);
  await shot(page, "28-home");
});

test("isolation: Editing Room interactions make no outside requests", async ({ page }) => {
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: /Ask Maven/ }).click();
  await page.getByRole("button", { name: "Summarize this video" }).click();
  await expect(page.getByRole("dialog").locator(".msg.cue")).toHaveCount(1);
  const outside = requests.filter((u) => { const h = new URL(u).hostname; return !["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(h) && !/^(data|blob):/.test(u); });
  expect(outside).toEqual([]);
});
