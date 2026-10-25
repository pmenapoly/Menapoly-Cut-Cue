import { expect, Page, test } from "@playwright/test";

// Reliability and security checks for the preview's mock service. These prove the preview's own rules; the production
// server must enforce the same ones (docs/studio/workflow-audit.md, "Backend requirements").

const proj = () => test.info().project.name;
async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}
async function asRole(page: Page, userId: string) {
  await open(page, "settings");
  await page.locator("#role-select").selectOption(userId);
  await expect(page.locator(".role-chip")).toBeVisible();
}
/** Calls the preview's service layer directly, as the signed-in demo person (no network: it's the in-page mock). */
const svcCall = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(async ([fn, args]) => {
  const { svc } = await import("/js/" + "service.js");
  try { return { ok: true, value: await (svc as any)[fn as string](...(args as unknown[])) }; } catch (e: any) { return { ok: false, code: e.code, message: e.message }; }
}, [fn, args] as const);

test.beforeEach(() => { test.skip(proj() === "android-360", "service-level checks; one phone and desktop are enough"); });

test("stale decisions: a newer version, a settled video, or another tab's decision is refused", async ({ page, context }) => {
  await open(page, "video-v_launch");
  // Approving a version that is no longer the latest (version 1 shown, version 2 is current)
  expect(await svcCall(page, "decide", "rv_launch", "approve", "", 1)).toMatchObject({ ok: false, code: 409 });
  // A second tab approves; this tab re-renders with the change, and a late decision is refused
  const other = await context.newPage();
  await open(other, "video-v_launch");
  await other.getByRole("button", { name: "Approve video" }).click();
  await expect(other.locator(".room-head [data-status]")).toHaveText("Approved");
  await expect(page.getByText("Updated with changes from another tab")).toBeVisible();
  await expect(page.locator(".room-head [data-status]")).toHaveText("Approved");
  expect(await svcCall(page, "decide", "rv_launch", "approve", "", 2)).toMatchObject({ ok: false, code: 409 });
  expect(await svcCall(page, "decide", "rv_launch", "changes", "too late", 2)).toMatchObject({ ok: false, code: 409 });
  // An approved video can't get a new version; that's what "Make more from this video" is for
  await asRole(page, "u_sam");
  expect(await svcCall(page, "uploadVersion", "rv_launch", "late cut")).toMatchObject({ ok: false, code: 409 });
});

test("duplicate submissions: the same request draft and the same proposal run once", async ({ page }) => {
  await open(page, "home");
  const data = { projectId: "p_launch", type: "short", title: "Dup check", brief: "Brief", key: "draft-123" };
  const a = await svcCall(page, "createRequest", data), b = await svcCall(page, "createRequest", data);
  expect((a.value as any).id).toBe((b.value as any).id);
  const prop = await svcCall(page, "propose", "folder", { ws: "ws_nw", name: "Dup folder" }, "Create folder");
  const pid = (prop.value as any).id;
  const [x, y] = await page.evaluate(async (pid) => { const { svc } = await import("/js/" + "service.js");
    return Promise.allSettled([svc.decideProposal(pid, true), svc.decideProposal(pid, true)]).then((r) => r.map((s) => s.status)); }, pid);
  expect([x, y].sort()).toEqual(["fulfilled", "rejected"]);
  const folders = await svcCall(page, "folders", "ws_nw");
  expect((folders.value as any[]).filter((f) => f.name === "Dup folder")).toHaveLength(1);
});

test("unsaved feedback survives navigation and reloads until it's sent", async ({ page }) => {
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByLabel("What should change?").fill("Warmer grade on the roastery shots");
  await open(page, "home");
  await page.reload();
  await open(page, "video-v_launch");
  await expect(page.getByLabel("What should change?")).toHaveValue("Warmer grade on the roastery shots");
  await page.getByRole("button", { name: "Send to the editor" }).click();
  await expect(page.locator(".room-head [data-status]")).toHaveText("Changes requested");
  await page.reload();
  await expect(page.getByLabel("What should change?")).toHaveCount(0); // sent drafts are cleared
});

test("isolation: another client's rooms, files, templates and notifications stay out of reach", async ({ page }) => {
  await asRole(page, "u_priya");
  for (const token of ["video-v_launch", "project-p_launch", "asset-a_launch_v2"]) {
    await open(page, token);
    await expect(page.getByText("You don't have access to this")).toBeVisible();
  }
  expect(await svcCall(page, "templates", "ws_nw")).toMatchObject({ ok: false, code: 403 });
  expect(await svcCall(page, "projectActivity", "p_launch")).toMatchObject({ ok: false, code: 403 });
  expect(await svcCall(page, "production")).toMatchObject({ ok: false, code: 403 }); // clients have no production board
  // A Northwind template can't be smuggled into a Harborline request
  const r = await svcCall(page, "createRequest", { projectId: "p_promo", type: "short", title: "T", brief: "B", templateId: "tpl_reels" });
  expect((r.value as any).templateId).toBeNull();
  // Footage from another workspace can't be attached
  expect(await svcCall(page, "createRequest", { projectId: "p_promo", type: "short", title: "T2", brief: "B", assetIds: ["a_launch_v2"] })).toMatchObject({ ok: false, code: 400 });
  // Editors see only their own queue, never other editors' requests
  await asRole(page, "u_mika");
  const q = await svcCall(page, "production");
  expect((q.value as any).rows.every((row: any) => row.assigneeId === "u_mika")).toBe(true);
  expect((q.value as any).editors).toEqual([]);
});

test("notifications reach the right people only", async ({ page }) => {
  await open(page, "video-v_launch");
  await svcCall(page, "addComment", "rv_launch", { version: 2, t: 3, body: "Targeting check" });
  const inbox = async (uid: string) => { await page.evaluate(async (uid) => { const { svc } = await import("/js/" + "service.js"); svc.switchUser(uid); }, uid);
    return ((await svcCall(page, "notifications")).value as any[]).filter((n) => /left feedback at 0:03/.test(n.text)).length; };
  expect(await inbox("u_sam")).toBe(1);   // the assigned editor
  expect(await inbox("u_admin")).toBe(1); // the producer
  expect(await inbox("u_mika")).toBe(0);  // not on this project
  expect(await inbox("u_priya")).toBe(0); // another client
  expect(await inbox("u_jordan")).toBe(0); // never yourself
});
