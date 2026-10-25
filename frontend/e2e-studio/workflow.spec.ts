import { expect, Page, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The full production lifecycle, driven through the interface as four fictional people:
// Jordan (client, Northwind), Avery (Menapoly admin), Mika (editor) and Priya (client of another workspace).
// Each numbered step is recorded in docs/studio/workflow-results/<project>.json with what really ran.

const proj = () => test.info().project.name;
const OUT = path.join(__dirname, "..", "..", "docs", "studio", "workflow-results");
const TITLE = "Roastery behind-the-scenes reel";

async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
async function asRole(page: Page, userId: string) {
  await open(page, "settings");
  await page.locator("#role-select").selectOption(userId);
  await expect(page.locator(".role-chip")).toBeVisible();
}
const status = (page: Page) => page.locator(".room-head [data-status]");
const tab = (page: Page, name: string | RegExp) => page.getByRole("tablist", { name: "Editing Room" }).getByRole("tab", { name });
async function openFromInbox(page: Page, text: string | RegExp) {
  await open(page, "inbox");
  const item = page.locator(".item", { hasText: text }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
}

test("23-step workflow: upload → request → edit → review → approve → reuse → social", async ({ page }) => {
  test.skip(proj() === "android-360", "runs at 430 and 1440; the layout sweep covers 360");
  test.setTimeout(240_000);
  const steps: { n: number; step: string; result: string; detail: string }[] = [];
  let n = 0;
  const step = async (name: string, detail: string, fn: () => Promise<void>) => {
    n += 1;
    await test.step(`${n}. ${name}`, async () => {
      try { await fn(); steps.push({ n, step: name, result: "passed", detail }); }
      catch (e) { steps.push({ n, step: name, result: "failed", detail: String(e).slice(0, 300) }); throw e; }
    });
  };
  try {
    await open(page, "home");
    await step("Client uploads footage", "Library → Add files (simulated: name, size and type only)", async () => {
      await open(page, "library");
      await page.locator("#lib-file").setInputFiles({ name: "roastery-broll.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
      await expect(page.getByText("roastery-broll.mp4 added")).toBeVisible();
    });
    await step("Client creates an editing request", "Request form with the uploaded footage and a demo clip attached", async () => {
      await open(page, "request-new");
      await page.getByRole("radio", { name: /Short-form social clips/ }).click();
    });
    await step("Client starts from a template", "“Reel cut-down pack”: its checklist and instructions go into the new Editing Room", async () => {
      await page.locator("#rq-template").selectOption({ label: "Reel cut-down pack" });
      await expect(page.getByText(/Using the template “Reel cut-down pack”/)).toBeVisible();
      await page.getByLabel("Title").fill(TITLE);
      await page.getByLabel("Brief").fill("Show the roasting floor in 30 seconds. Product in the first two seconds, captions on.");
      await page.getByRole("checkbox", { name: /roastery-broll\.mp4/ }).check();
      await page.getByRole("checkbox", { name: /brew-tips-reel-01\.mp4/ }).check();
      await page.getByRole("button", { name: "Submit request" }).dblclick(); // a double tap must not create two requests
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch Campaign");
      await expect(page.getByRole("heading", { name: TITLE })).toHaveCount(1);
    });
    await step("Administrator reviews the request", "Avery's notification and the production board's “Needs an editor” lane", async () => {
      await asRole(page, "u_admin");
      await open(page, "inbox");
      await expect(page.locator(".item", { hasText: `New editing request: ${TITLE}` })).toBeVisible();
      await open(page, "studio-board");
      await expect(page.locator("[data-lane=needs]")).toContainText(TITLE);
    });
    await step("Administrator assigns an editor", "Assign Mika Chen from the new request's Editing Room", async () => {
      await page.locator("[data-lane=needs] .item", { hasText: TITLE }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
      await page.locator("#room-assign").selectOption({ label: "Mika Chen" });
      await page.getByRole("button", { name: "Assign", exact: true }).click();
      await expect(page.getByText("Editor assigned and notified")).toBeVisible();
      await expect(page.locator(".room-head")).toContainText("Editor: Mika Chen");
    });
    await step("Editor receives the assignment", "Mika's inbox links straight to the Editing Room", async () => {
      await asRole(page, "u_mika");
      await openFromInbox(page, `You were assigned: ${TITLE}`);
    });
    await step("Editor reviews the brief and checklist", "Brief from the request; checklist from the template, owned by Mika", async () => {
      await expect(page.locator(".room-panel")).toContainText("Show the roasting floor");
      await expect(page.locator(".room-panel")).toContainText("Pick three strongest moments");
      await expect(page.locator(".room-panel")).toContainText("Mika Chen");
    });
    await step("Editor submits an edited version", "Start editing → tick a task → submit (simulated: reuses a synthetic clip)", async () => {
      await page.getByRole("button", { name: "Start editing" }).click();
      await expect(status(page)).toHaveText("Being edited");
      await page.getByRole("checkbox", { name: /Pick three strongest moments/ }).check();
      await expect(page.getByRole("checkbox", { name: /Pick three strongest moments/ })).toBeChecked();
      await page.getByLabel("Submit a new version").fill("First cut");
      await page.getByRole("button", { name: "Upload new version" }).click();
      await expect(status(page)).toHaveText("Ready for review");
    });
    await step("Client receives a review notification", "“Version 1 … is ready for your review” in Jordan's inbox", async () => {
      await asRole(page, "u_jordan");
      await openFromInbox(page, `Version 1 of ${TITLE} is ready for your review`);
    });
    await step("Client plays the video and adds timestamped feedback", "Real playback of the synthetic clip, then feedback at the playhead", async () => {
      await page.getByRole("button", { name: "Play" }).click();
      await expect.poll(() => page.locator(".vp video").evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
      await page.getByRole("button", { name: "Pause" }).click();
      await page.locator(".room-panel .btn.primary", { hasText: "Leave feedback at" }).click();
    });
    await step("Client uses a frame annotation", "Box drawn on the frame, saved with the comment", async () => {
      await page.getByRole("button", { name: "Box" }).click();
      const c = (await page.locator(".vp-draw").boundingBox())!;
      // Portrait clips make the player taller than a phone screen: draw in the part that's on screen.
      const top = Math.max(c.y, 120) + 30, bottom = Math.min(c.y + c.height, page.viewportSize()!.height - 140);
      await page.mouse.move(c.x + c.width * 0.3, top); await page.mouse.down();
      await page.mouse.move(c.x + c.width * 0.7, Math.min(bottom, top + 160), { steps: 6 }); await page.mouse.up();
      await expect(page.locator(".composer-card")).toContainText("area marked");
      await page.locator("#annotation-body").fill("Open on the roaster, not the bags.");
      await page.getByRole("button", { name: "Send feedback" }).click();
      await expect(page.locator(".note", { hasText: "Open on the roaster" })).toContainText("marked");
    });
    await step("Client requests changes", "A note is required; the editor and admins are told", async () => {
      await page.getByRole("button", { name: "Request changes" }).click();
      await page.getByLabel("What should change?").fill("Open on the roaster, please.");
      await page.getByRole("button", { name: "Send to the editor" }).click();
      await expect(status(page)).toHaveText("Changes requested");
    });
    await step("Editor receives and resolves the feedback", "Notifications for the feedback and the change request; Resolve on the comment", async () => {
      await asRole(page, "u_mika");
      await open(page, "inbox");
      await expect(page.locator(".item", { hasText: `left feedback` }).first()).toBeVisible();
      await openFromInbox(page, `Changes requested on ${TITLE}`);
      await tab(page, /Comments/).click();
      await page.locator(".note", { hasText: "Open on the roaster" }).getByRole("button", { name: "Resolve" }).click();
      await expect(page.getByText("Resolved").first()).toBeVisible();
    });
    await step("Editor submits a new version", "Start the changes → version 2 (simulated)", async () => {
      await page.getByRole("button", { name: "Start the changes" }).click();
      await expect(status(page)).toHaveText("Being edited");
      await page.getByLabel("Submit a new version").fill("Opens on the roaster");
      await page.getByRole("button", { name: "Upload new version" }).click();
      await expect(status(page)).toHaveText("Ready for review");
    });
    await step("Client compares versions", "Side-by-side sheet with two playable videos", async () => {
      await asRole(page, "u_jordan");
      await openFromInbox(page, `Version 2 of ${TITLE} is ready for your review`);
      await page.getByRole("button", { name: "Compare versions" }).click();
      await expect(page.getByRole("dialog").locator("video")).toHaveCount(2);
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    });
    await step("Client approves the completed video", "Approval of the version on screen (version 2)", async () => {
      await page.getByRole("button", { name: "Approve video" }).click();
      await expect(status(page)).toHaveText("Approved");
    });
    await step("Approved video becomes available for reuse", "Its deliverable file is in the Library and counted as ready to reuse", async () => {
      await open(page, "library");
      await expect(page.locator(".tile", { hasText: "roastery-behind-the-scenes-reel-v2.mp4" })).toContainText("Approved");
    });
    await step("Client chooses “Make more from this video”", "Creates a new request with its own Editing Room", async () => {
      await page.locator(".tile", { hasText: "roastery-behind-the-scenes-reel-v2.mp4" }).click();
      await page.getByRole("button", { name: "Make more from this video" }).click();
      await page.locator("#another-change").fill("A 15-second teaser");
      await page.getByRole("button", { name: "Send request" }).click();
      await expect(page.getByText(`Requested: New version of ${TITLE}`)).toBeVisible();
    });
    await step("Maven prepares repurposing suggestions", "Several separate proposals from the approved video (deterministic)", async () => {
      await page.getByRole("button", { name: /Ask Maven/ }).click();
      await page.locator("#maven-input").fill("Repurposing ideas");
      await page.locator("#maven-input").press("Enter");
      await expect(page.locator(".maven-sheet .proposal")).toHaveCount(3);
    });
    await step("Client approves selected suggestions", "Approve the social draft; decline the feed idea; the clips idea stays waiting", async () => {
      const sheet = page.locator(".maven-sheet");
      await sheet.locator(".proposal", { hasText: "Save a social draft" }).getByRole("button", { name: "Approve" }).click();
      await expect(sheet.locator(".proposal.done")).toHaveCount(1);
      await sheet.locator(".proposal", { hasText: "behind-the-scenes idea" }).getByRole("button", { name: "Decline" }).click();
      await expect(sheet.locator(".proposal.declined")).toHaveCount(1);
      await expect(sheet.locator(".proposal:not(.done):not(.declined)")).toHaveCount(1);
      await sheet.getByRole("button", { name: "Close" }).click();
    });
    await step("New requests and drafts are created", "The new request is listed with its Editing Room; the social draft exists", async () => {
      await open(page, "studio");
      await page.getByRole("tab", { name: "Requests" }).click();
      await expect(page.locator(".item", { hasText: `New version of ${TITLE}` })).toContainText("Submitted");
      await open(page, "social");
      await expect(page.locator("article.card", { hasText: "roastery-behind-the-scenes-reel-v2.mp4" })).toContainText("Draft");
    });
    await step("Approved content is prepared for Social Sharing", "Send for approval → approve → admin prepares to schedule (simulated; nothing posted)", async () => {
      const card = page.locator("article.card", { hasText: "roastery-behind-the-scenes-reel-v2.mp4" });
      await card.getByRole("button", { name: "Send for approval" }).click();
      await expect(card).toContainText("Awaiting approval");
      await card.getByRole("button", { name: "Approve" }).click();
      await expect(card).toContainText("Approved");
      await asRole(page, "u_admin");
      await open(page, "social");
      await page.locator("#ws-picker").selectOption({ label: "Northwind Roasters" }).catch(() => {});
      const adminCard = page.locator("article.card", { hasText: "roastery-behind-the-scenes-reel-v2.mp4" });
      await adminCard.getByRole("button", { name: "Prepare to schedule" }).click();
      await expect(adminCard).toContainText("Ready to schedule (simulated)");
      await expect(page.locator(".pipeline")).toContainText("Published");
      await expect(page.locator(".pipe-step", { hasText: "Published" }).locator("b")).toHaveText("0");
    });
    await step("Activity and notifications reflect the workflow", "Project activity, Jordan's inbox, and nothing leaked to Priya", async () => {
      await open(page, "project-p_launch");
      const act = page.getByRole("region", { name: "Project activity" });
      for (const t of ["approved version 2", "submitted version 2", "requested changes", "assigned editor", "submitted editing request"]) await expect(act).toContainText(t);
      await asRole(page, "u_jordan");
      await open(page, "inbox");
      await expect(page.locator(".item", { hasText: `Mika Chen will edit “${TITLE}”` })).toBeVisible();
      await asRole(page, "u_priya");
      await open(page, "inbox");
      await expect(page.locator(".item", { hasText: TITLE })).toHaveCount(0);
    });
  } finally {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${proj()}.json`), JSON.stringify({ project: proj(), at: new Date().toISOString(), steps }, null, 2));
  }
});
