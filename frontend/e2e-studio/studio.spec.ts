import { expect, Page, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Interactive acceptance tests for the Menapoly Cue Studio preview (fictional data, local only).
// Each test starts with a fresh browser context, so the demo data is re-seeded every time.

const proj = () => test.info().project.name;
const phone = () => proj().startsWith("android");
const SHOTS = path.join(__dirname, "..", "..", "docs", "studio", "screenshots");

async function shot(page: Page, name: string) {
  const dir = path.join(SHOTS, proj());
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}
async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
async function noSideScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]);
  expect(sw, "page must not scroll sideways").toBeLessThanOrEqual(iw);
}
async function asRole(page: Page, userId: string) {
  await open(page, "settings");
  await page.locator("#role-select").selectOption(userId);
  await expect(page.locator(".role-chip")).toBeVisible();
}
async function navTo(page: Page, label: string) {
  const bar: Record<string, string> = { Home: "Home", "Media Studio": "Studio", Review: "Review", "Ask Cue": "Ask Cue" };
  if (!phone()) return page.locator(".rail").getByRole("link", { name: new RegExp(`^${label}`) }).click();
  if (bar[label]) return page.locator(".bar a", { hasText: bar[label] }).click();
  await page.locator(".bar button", { hasText: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: label }).click();
}

// Records every request so the isolation test can prove nothing leaves the preview.
const requests: string[] = [];
test.beforeEach(async ({ page }) => { requests.length = 0; page.on("request", (r) => requests.push(r.url())); });

test("shell, navigation, back button and no sideways scroll", async ({ page }) => {
  await open(page, "home");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Jordan");
  if (phone()) { await expect(page.locator(".bar")).toBeVisible(); await expect(page.locator(".rail")).toBeHidden(); }
  else { await expect(page.locator(".rail")).toBeVisible(); await expect(page.locator(".bar")).toBeHidden(); }
  await shot(page, "01-home");
  for (const [label, heading] of [["Studio", "Production"], ["Review", "Cuts to review"], ["Ask Cue", "Ask Cue"], ["Social Sharing", "Social Sharing"],
    ["AI Visibility", "AI Visibility"], ["Library", "Library"], ["Inbox", "Inbox"], ["Settings", "Settings"]] as const) {
    await navTo(page, label === "Studio" ? "Media Studio" : label);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await noSideScroll(page);
  }
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbox");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Library");
  // No standalone Coaching destination (tutorials arrive through Home announcements and the spotlight).
  await expect(page.locator(".rail a, .bar a").filter({ hasText: "Coaching" })).toHaveCount(0);
  await open(page, "coaching");
  await expect(page.getByText("doesn't exist in the preview")).toBeVisible();
});

test("touch targets, labels and alt text", async ({ page }) => {
  for (const token of ["home", "studio", "project-p_launch", "video-v_launch", "library", "social", "visibility", "ask", "request-new"]) {
    await open(page, token);
    const bad = await page.evaluate((isPhone) => {
      const out: string[] = [];
      const els = [...document.querySelectorAll<HTMLElement>("button, a.btn, a.tab, [role=tab], .bar a, .rail a, input:not([type=checkbox]):not([type=file]), select, textarea, summary")];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden" || el.closest(".sr")) continue;
        const name = el.getAttribute("aria-label") || el.textContent?.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.getAttribute("placeholder");
        if (!name) out.push(`no accessible name: ${el.outerHTML.slice(0, 80)}`);
        if (isPhone && r.height < 43.5) out.push(`too small (${Math.round(r.width)}×${Math.round(r.height)}): ${el.outerHTML.slice(0, 80)}`);
      }
      document.querySelectorAll("img").forEach((i) => { if (!i.hasAttribute("alt")) out.push(`img without alt: ${i.src}`); });
      return out;
    }, phone());
    expect(bad, `${token}`).toEqual([]);
  }
});

test("universal search respects access", async ({ page }) => {
  await open(page, "home");
  await page.locator(phone() ? ".top .search-btn" : ".top .top-search").click();
  const box = page.getByRole("dialog", { name: "Search" });
  await box.getByLabel("Search everything").fill("spring");
  await expect(box.locator(".item[href='#project-p_launch']")).toBeVisible();
  await expect(box.locator(".item[href='#video-v_launch']", { hasText: "Editing Room" })).toBeVisible();
  await shot(page, "02-search");
  await box.getByLabel("Search everything").fill("harborline");
  await expect(box.getByText("No matches")).toBeVisible(); // Jordan can't see the other client's workspace
  await box.getByLabel("Search everything").fill("spring");
  await box.locator(".item[href='#project-p_launch']").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch Campaign");
});

test("library: folders, filters, moving files, empty state", async ({ page }) => {
  await open(page, "library");
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Holiday campaign");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.locator(".folder.on")).toHaveText("Holiday campaign");
  await expect(page.getByText("This folder is empty")).toBeVisible();
  await page.getByRole("button", { name: "All files" }).click();
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(3);
  await page.getByRole("button", { name: "Move brew-tips-reel-01.mp4" }).click();
  await page.getByRole("dialog").getByLabel("Move to folder").selectOption({ label: "Holiday campaign" });
  await page.getByRole("dialog").getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Moved" })).toBeVisible();
  await open(page, "library");
  await page.getByRole("button", { name: "Holiday campaign" }).click();
  await expect(page.locator(".tile")).toHaveCount(1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search the library").fill("zzz-nothing");
  await page.getByLabel("Search the library").press("Enter");
  await expect(page.getByText("Nothing matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".tile").first()).toBeVisible();
  // simulated upload: only name/size kept, nothing sent anywhere
  await page.locator("#lib-file").setInputFiles({ name: "fictional-broll.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
  await expect(page.getByText("fictional-broll.mp4 added")).toBeVisible();
  await page.locator("#lib-file").setInputFiles({ name: "script.exe", mimeType: "application/x-msdownload", buffer: Buffer.alloc(10) });
  await expect(page.getByText("that file type isn't accepted")).toBeVisible();
  await noSideScroll(page);
  await shot(page, "03-library");
});

test("editing request: draft survives reload, validation, submit, persists", async ({ page }) => {
  await open(page, "request-new");
  await page.getByRole("radio", { name: /Short-form social clips/ }).click();
  await page.getByLabel("Title").fill("Three reels from the roastery shoot");
  await page.reload();
  await expect(page.getByLabel("Title")).toHaveValue("Three reels from the roastery shoot");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Add a title and a brief")).toBeVisible();
  await page.getByLabel("Brief").fill("Open on the roaster, captions on, end card with the shop link.");
  await shot(page, "04-request-form");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spring Launch Campaign");
  await expect(page.getByRole("heading", { name: "Three reels from the roastery shoot" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Three reels from the roastery shoot" })).toBeVisible();
  await open(page, "studio");
  await page.getByRole("tab", { name: "Requests" }).click();
  await expect(page.locator(".item", { hasText: "Three reels from the roastery shoot" })).toContainText("Submitted");
});

test("roles: editors and other clients can't reach what isn't theirs", async ({ page }) => {
  await asRole(page, "u_mika");
  await open(page, "review");
  await expect(page.locator(".tile")).toHaveCount(0); // reel is approved; filter shows open only
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator(".tile")).toContainText("Brew Tips");
  await open(page, "review-rv_launch");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await open(page, "visibility");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await expect(page.locator(".rail a, .bar a", { hasText: "AI Visibility" })).toHaveCount(0);
  await shot(page, "08-editor-denied");
  await asRole(page, "u_priya");
  await open(page, "project-p_launch");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await open(page, "studio");
  await expect(page.locator(".card h2")).toHaveText(["Harborline Talks — Ep. 12", "January Membership Promo"]);
  await open(page, "clients");
  await expect(page.getByText("You don't have access to this")).toBeVisible();
  await asRole(page, "u_admin");
  await open(page, "clients");
  await expect(page.locator(".card")).toHaveCount(2);
});

test("AI Visibility: fictional labels, filters, modules and plan gating", async ({ page }) => {
  await open(page, "visibility");
  await expect(page.getByText("Fictional demo data").first()).toBeVisible();
  const ticks = () => page.locator("svg.chart").first().locator("text").allTextContents();
  expect((await ticks()).some((t) => t === "W12")).toBe(true);
  await expect(page.getByText("When live:").first()).toBeVisible();
  await page.getByLabel("Date range").selectOption("4");
  await expect.poll(async () => (await ticks()).some((t) => t === "W4") && !(await ticks()).some((t) => t === "W12")).toBe(true);
  for (const m of ["AI Search", "Website", "Social", "Video", "Competitive", "Reports", "Actions"]) {
    await page.getByRole("navigation", { name: "Visibility modules" }).getByRole("link", { name: m }).click();
    await expect(page.locator(".card h2").first()).toBeVisible();
    await expect(page.getByText("Fictional demo data").first()).toBeVisible();
  }
  await shot(page, "09-visibility");
  await asRole(page, "u_priya");
  await open(page, "visibility-competitive");
  await expect(page.getByText("isn't in the Essentials plan")).toBeVisible();
  await open(page, "visibility-overview");
  await expect(page.locator("svg.chart").first()).toBeVisible();
});

test("Ask Cue: answers from data, and a proposal only acts after approval", async ({ page }) => {
  await open(page, "ask");
  await expect(page.getByText("No AI model is connected")).toBeVisible();
  await page.getByRole("button", { name: "What needs my approval?" }).click();
  await expect(page.locator(".msg.cue").last()).toContainText("Review: Spring Launch hero spot");
  await page.getByRole("button", { name: "Draft a brief for cut-downs" }).click();
  const prop = page.locator(".proposal").last();
  await expect(prop).toContainText("Waiting for you");
  await open(page, "studio");
  await page.getByRole("tab", { name: "Requests" }).click();
  await expect(page.locator(".item", { hasText: "Cut-downs from" })).toHaveCount(0); // nothing happened yet
  await open(page, "ask");
  await page.locator(".proposal").last().getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".proposal").last()).toContainText("Done");
  await shot(page, "10-ask");
  await open(page, "studio");
  await page.getByRole("tab", { name: "Requests" }).click();
  await expect(page.locator(".item", { hasText: "Cut-downs from" })).toHaveCount(1);
});

test("Social Sharing: draft, approve, prepare (simulated), calendar", async ({ page }) => {
  await open(page, "social");
  await expect(page.getByText("nothing is posted")).toBeVisible();
  await page.getByRole("button", { name: "Draft a post" }).first().click();
  const d = page.getByRole("dialog", { name: "Draft a post" });
  await d.getByLabel("Caption").fill("Brew tip: weigh your beans.");
  await d.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByText("Draft sent for approval")).toBeVisible();
  const card = page.locator("article.card", { hasText: "Awaiting approval" }).first();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Post approved")).toBeVisible();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("grid", { name: "Content calendar" })).toBeVisible();
  await asRole(page, "u_admin");
  await open(page, "social");
  await page.getByRole("tab", { name: "Posts" }).click();
  await page.locator("article.card", { hasText: "Approved" }).first().getByRole("button", { name: "Prepare to schedule" }).click();
  await expect(page.locator(".toast", { hasText: "Prepared for scheduling (simulated, nothing posted)" })).toBeVisible();
  await shot(page, "11-social");
});

test("tutorial progress and error states", async ({ page }) => {
  await open(page, "lesson-l_review");
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  await shot(page, "12-tutorial");
  await open(page, "settings");
  await page.getByLabel("Simulate a service outage").check();
  await page.goto("/#studio");
  await expect(page.getByText("Couldn't load this")).toBeVisible();
  await shot(page, "13-error-state");
  await open(page, "settings");
  await page.getByLabel("Simulate a service outage").uncheck();
  await page.goto("/#studio");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Production");
  await open(page, "no-such-page");
  await expect(page.getByText("doesn't exist in the preview")).toBeVisible();
});

test("isolation: no request leaves the preview; production is never contacted", async ({ page }) => {
  for (const t of ["home", "studio", "library", "project-p_launch", "video-v_launch", "social", "visibility", "ask", "settings"]) await open(page, t);
  const outside = requests.filter((u) => { const h = new URL(u).hostname; return !["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(h) && !u.startsWith("data:") && !u.startsWith("blob:"); });
  expect(outside).toEqual([]);
  expect(requests.some((u) => /workers\.dev|menapoly-digital|cloudflare/.test(u))).toBe(false);
  const src = fs.readdirSync(path.join(__dirname, "..", "..", "studio-preview", "js")).map((f) => fs.readFileSync(path.join(__dirname, "..", "..", "studio-preview", "js", f), "utf8")).join("\n");
  expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon|workers\.dev/);
});
