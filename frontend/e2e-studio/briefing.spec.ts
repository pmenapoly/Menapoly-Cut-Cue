import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";
import path from "node:path";

// Upload-first, Phase 3: client briefing in the draft Editing Room (fictional people and files, in-page mock, no network).
// The brief autosaves with revision checks, shows what's missing, then Mark ready → Submit editing request. Submitting
// creates exactly one request, freezes the brief, and the same link opens the normal Editing Room.

const proj = () => test.info().project.name;
const CLIP = path.join(__dirname, "..", "..", "studio-preview", "media", "nw-launch-v1.webm");
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
const saved = (page: Page) => expect(page.locator("[data-save]")).toHaveText(/^Saved · revision \d+$/);
async function newDraft(page: Page, title = "Roastery floor") {
  await open(page, "studio");
  await page.getByRole("button", { name: "Upload & brief" }).click();
  await page.locator("#up-file").setInputFiles(CLIP);
  await page.locator("#up-title").fill(title);
  await page.locator("#up-go").click();
  await expect(stage(page)).toHaveText("Uploaded");
  return roomId(page);
}
async function fillEssentials(page: Page) {
  await page.getByLabel("What should this video achieve?").fill("Bring people to opening weekend");
  await page.getByLabel("Editing instructions").fill("Open on the bean pour (0:04). Warm and slow. End on the storefront.");
  await page.locator(".pick", { hasText: "Instagram" }).click();
  await page.locator(".pick", { hasText: "9:16 vertical" }).click();
  await saved(page);
}

test.beforeEach(() => { test.skip(proj() === "android-360", "runs at 430 and 1440; the layout check covers 360"); });

test("the brief autosaves, shows what's missing, survives a reload, and creates no production work", async ({ page }) => {
  const rid = await newDraft(page);
  const ready = page.getByRole("button", { name: "Mark ready to submit" });
  await expect(ready).toBeDisabled();
  await expect(page.getByLabel("Brief checklist").locator("[data-ok=false]")).toHaveCount(4); // outcome, instructions, platforms + optional date
  await fillEssentials(page);
  await expect(stage(page)).toHaveText("Preparing instructions");
  await expect(ready).toBeEnabled();
  await page.getByLabel("When would you like it?").fill("2026-12-04");
  await page.getByText("More details (optional)").click();
  await page.getByLabel("Brand notes").fill("Logo for the last 2 seconds\nWarm grade");
  await page.getByLabel("References").fill("https://example.com/last-season\nLast season's reel");
  await saved(page);
  // Typing right before a reload is kept and saved after it
  await page.getByLabel("Editing instructions").fill("Open on the bean pour (0:04). Warm and slow. End on the storefront with the date.");
  await page.reload();
  await expect(page.getByLabel("Editing instructions")).toHaveValue("Open on the bean pour (0:04). Warm and slow. End on the storefront with the date.");
  await saved(page);
  await expect(page.getByLabel("What should this video achieve?")).toHaveValue("Bring people to opening weekend");
  await expect(page.getByLabel("When would you like it?")).toHaveValue("2026-12-04");
  await expect(page.getByLabel("Brand notes")).toHaveValue("Logo for the last 2 seconds\nWarm grade");
  await expect(page.locator(".pick", { hasText: "Instagram" }).locator("input")).toBeChecked();
  const brief = ((await svcCall(page, "room", rid)).value as any).brief;
  expect(brief.fields.references).toEqual([{ label: "https://example.com/last-season", url: "https://example.com/last-season", assetId: null }, { label: "Last season's reel", url: null, assetId: null }]);
  expect(brief.editLog.map((e: any) => e.field)).toEqual(expect.arrayContaining(["outcome", "instructions", "platforms", "aspects", "requestedDate", "brand", "references"]));
  // Still a draft: nothing reached production
  expect(((await svcCall(page, "room", rid)).value as any).requestId).toBeNull();
  await as(page, "u_admin");
  expect(((await svcCall(page, "notifications")).value as any[]).some((n) => /Roastery floor/.test(n.text))).toBe(false);
  expect(((await svcCall(page, "production")).value as any).rows.some((r: any) => r.videoId === rid)).toBe(false);
  await open(page, "studio");
  await expect(page.locator(`[data-draft-room=${rid}]`)).toContainText("Preparing instructions");
});

test("a save from an older tab is refused, never overwrites, and the room shows the latest", async ({ page, context }) => {
  const rid = await newDraft(page);
  await fillEssentials(page);
  const other = await context.newPage();
  await open(other, `video-${rid}`);
  const rev = ((await svcCall(other, "room", rid)).value as any).brief.rev;
  // The race: typing in the first tab is still waiting to save when the second tab saves its own change
  await page.getByLabel("What should this video achieve?").fill("Typed in the first tab");
  await expect(page.locator("[data-save]")).toHaveText("Unsaved changes…");
  expect(await svcCall(other, "saveBrief", rid, { outcome: "Changed in the second tab" }, rev)).toMatchObject({ ok: true });
  await expect(page.locator(".toast.err", { hasText: /changed in another tab|brief changed since/ }).first()).toBeVisible();
  await expect(page.getByLabel("What should this video achieve?")).toHaveValue("Changed in the second tab");
  await page.waitForTimeout(1500); // any leftover save attempt has run by now
  expect(((await svcCall(page, "room", rid)).value as any).brief.fields.outcome).toBe("Changed in the second tab"); // never overwritten
});

test("mark ready, lose an essential → back to draft; submit with a double tap → one request and the Editing Room", async ({ page }) => {
  const rid = await newDraft(page, "Opening weekend teaser");
  await fillEssentials(page);
  await page.getByLabel("When would you like it?").fill("2026-12-04");
  await saved(page);
  await page.getByRole("button", { name: "Mark ready to submit" }).click();
  await expect(stage(page)).toHaveText("Ready to submit");
  await page.getByLabel("Editing instructions").fill("");
  await saved(page);
  await expect(page.getByRole("button", { name: "Mark ready to submit" })).toBeDisabled(); // an essential went missing
  await expect(stage(page)).toHaveText("Preparing instructions");
  await page.getByLabel("Editing instructions").fill("Open on the bean pour. Warm and slow.");
  await saved(page);
  await page.getByRole("button", { name: "Mark ready to submit" }).click();
  await page.getByRole("button", { name: "Submit editing request" }).dblclick();
  await expect(page.locator(".room-head [data-status]")).toHaveText("Waiting to start"); // the existing Editing Room, same link
  expect(roomId(page)).toBe(rid);
  await expect(page.locator("[data-requested]")).toHaveText(/Requested by Dec 4/);
  const room = (await svcCall(page, "room", rid)).value as any;
  expect(room).toMatchObject({ stage: "Submitted for editing", brief: { status: "submitted" }, request: { requestedDate: "2026-12-04", estimate: null } });
  expect(room.snapshots).toHaveLength(1); expect(room.snapshots[0].intact).toBe(true);
  expect(room.revisions.used).toBe(0);
  expect(((await svcCall(page, "requests")).value as any[]).filter((r) => r.roomId === rid)).toHaveLength(1);
  expect(await svcCall(page, "saveBrief", rid, { outcome: "late change" }, room.brief.rev)).toMatchObject({ ok: false, code: 409 }); // frozen
  // Production now sees it: Menapoly is told and it waits for an editor
  await as(page, "u_admin");
  expect(((await svcCall(page, "notifications")).value as any[]).filter((n) => /New editing request: Opening weekend teaser/.test(n.text))).toHaveLength(1);
  await open(page, "studio-board");
  await expect(page.locator("[data-lane=needs]")).toContainText("Opening weekend teaser");
  // Editors see it only once they're assigned
  await as(page, "u_mika");
  expect(await svcCall(page, "video", rid)).toMatchObject({ ok: false, code: 403 });
  await as(page, "u_admin"); await svcCall(page, "assignRequest", room.requestId, "u_mika");
  await as(page, "u_mika");
  await open(page, "home"); await open(page, `video-${rid}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Opening weekend teaser");
});

test("roles: an administrator can prepare a client's draft; other workspaces can't touch it", async ({ page }) => {
  const rid = await newDraft(page);
  await as(page, "u_admin");
  await open(page, "home"); await open(page, `video-${rid}`);
  await page.getByLabel("What should this video achieve?").fill("Prepared by the producer");
  await saved(page);
  await as(page, "u_priya");
  expect(await svcCall(page, "saveBrief", rid, { outcome: "x" }, 1)).toMatchObject({ ok: false, code: 403 });
  expect(await svcCall(page, "submitBrief", rid, { expectedRev: 1 })).toMatchObject({ ok: false, code: 403 });
});

test("the briefing room passes axe and fits 360, 430 and 1440 px with 44 px controls", async ({ page }) => {
  await newDraft(page);
  await fillEssentials(page);
  await page.getByText("More details (optional)").click();
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(res.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  test.skip(proj() !== "android-430", "one sweep covers every width");
  for (const [w, hgt] of [[360, 780], [430, 932], [768, 1024], [1440, 900]] as const) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.reload(); await expect(stage(page)).toHaveText("Preparing instructions");
    const issues = await page.evaluate(() => {
      const out: string[] = [];
      if (document.scrollingElement!.scrollWidth > innerWidth) out.push(`sideways scroll ${document.scrollingElement!.scrollWidth}`);
      document.querySelectorAll<HTMLElement>("main *").forEach((el) => { const b = el.getBoundingClientRect();
        if (b.width && b.right > innerWidth + 1 && !el.closest(".file-strip")) out.push(`overflows: ${el.tagName}.${el.className}`.slice(0, 80)); });
      document.querySelectorAll<HTMLElement>(".brief-form button, .brief-form .pick span, .brief-form summary, .brief-readiness button, .brief-form input:not([type=checkbox]), .brief-form textarea")
        .forEach((el) => { if (el.offsetWidth && el.getBoundingClientRect().height < 44) out.push(`small control: ${(el.textContent || el.id).trim().slice(0, 30)}`); });
      if (/\b(null|undefined|NaN)\b/.test(document.querySelector("main")!.innerText)) out.push("printed null/undefined/NaN");
      return [...new Set(out)];
    });
    expect(issues, `briefing room at ${w}px`).toEqual([]);
  }
});
