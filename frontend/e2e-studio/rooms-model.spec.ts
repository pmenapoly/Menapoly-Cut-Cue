import { expect, Page, test } from "@playwright/test";

// Upload-first rooms, Phase 1 (data model only; no new screens). In a real browser: a saved version 6 demo migrates
// without losing rooms, comments, approvals or revision usage; rooms exist without requests; retries don't duplicate.
// Fictional data; service calls run against the in-page mock (no network).

const proj = () => test.info().project.name;
async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
const svcCall = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(async ([fn, args]) => {
  const { svc } = await import("/js/" + "service.js");
  try { return { ok: true, value: await (svc as any)[fn as string](...(args as unknown[])) }; } catch (e: any) { return { ok: false, code: e.code, message: e.message }; }
}, [fn, args] as const);
const as = (page: Page, uid: string) => page.evaluate(async (uid) => { const { svc } = await import("/js/" + "service.js"); svc.switchUser(uid); }, uid);

test.beforeEach(() => { test.skip(proj() === "android-360", "runs at 430 and 1440"); });

test("a saved version 6 demo migrates to rooms and keeps working: same links, comments, rounds and approvals", async ({ page }) => {
  await open(page, "home");
  await page.evaluate(async () => {
    const { seed } = await import("/js/" + "data.js");
    const s: any = seed();
    for (const k of ["rooms", "briefs", "briefSnapshots", "notes", "uploadOps", "migrations"]) delete s[k];
    s.assets.forEach((a: any) => { delete a.storage; delete a.roomId; });
    s.requests.forEach((r: any) => { for (const k of ["roomId", "briefId", "briefRev", "snapshotId", "requestedDate"]) delete r[k]; });
    s.reviews.forEach((r: any) => r.comments.forEach((c: any) => delete c.phase));
    s.version = 6;
    localStorage.setItem("menapoly-cue-studio-demo", JSON.stringify(s));
  });
  await page.reload();
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("menapoly-cue-studio-demo") || "{}"));
  expect(saved.version).toBe(7);
  expect(saved.rooms.map((r: any) => r.id)).toEqual(["v_launch", "v_reel", "v_pod"]);
  expect(saved.migrations[0]).toMatchObject({ from: 6, to: 7, rooms: 3 });
  // The existing Editing Room, its comments and its revision usage are exactly as before
  await open(page, "video-v_launch");
  await expect(page.getByLabel("Revision rounds")).toContainText("1 of 3 used");
  await expect(page.getByText("Hold the bag shot half a second longer?").first()).toBeVisible();
  expect(await svcCall(page, "decide", "rv_launch", "approve", "", 2)).toMatchObject({ ok: true });
  await open(page, "video-v_reel");
  await expect(page.locator(".room-head [data-status]")).toHaveText("Approved");
  await as(page, "u_admin");
  const check = await svcCall(page, "integrity");
  expect(check.value).toMatchObject({ ok: true, rooms: 3 });
  expect(((await svcCall(page, "room", "v_launch")).value as any).stage).toBe("Approved");
});

test("rooms exist without requests, upload retries are idempotent, and storage is labelled honestly", async ({ page }) => {
  await open(page, "home");
  await svcCall(page, "reset");
  const file = { name: "roastery-floor.mp4", size: 48000000, type: "video/mp4" };
  const before = ((await svcCall(page, "videos")).value as any[]).length;
  const a = (await svcCall(page, "registerUpload", { opId: "op_browser_0001", projectId: "p_launch", file })).value as any;
  const b = (await svcCall(page, "registerUpload", { opId: "op_browser_0001", projectId: "p_launch", file })).value as any;
  expect(b.replayed).toBe(true); expect(b.room.id).toBe(a.room.id);
  expect(a.room).toMatchObject({ requestId: null, stage: "Uploaded" });
  expect(a.asset.storageInfo).toMatchObject({ storage: "none", uploaded: false });
  expect(((await svcCall(page, "videos")).value as any[]).length).toBe(before); // no new Studio row in Phase 1
  const other = (await svcCall(page, "registerUpload", { opId: "op_browser_0002", projectId: "p_reels", file })).value as any;
  expect(other.room.id).not.toBe(a.room.id);
  expect(await svcCall(page, "persistence")).toMatchObject({ ok: true, value: { ok: true, mode: "browser" } });
  await page.reload(); // the room survives a refresh (draft metadata is saved); the file has no stored bytes
  expect(((await svcCall(page, "room", a.room.id)).value as any).assets[0].storageInfo.available).toBe(false);
  await as(page, "u_sam");
  expect(await svcCall(page, "room", a.room.id)).toMatchObject({ ok: false, code: 403 });
});
