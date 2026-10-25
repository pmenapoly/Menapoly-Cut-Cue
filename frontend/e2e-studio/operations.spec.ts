import { expect, Page, test } from "@playwright/test";

// Production operations: social review cycle, revision allowances and administrator overrides, target dates and
// workload. Fictional people: Jordan (client, Northwind), Avery (admin), Sam and Mika (editors), Priya (other client).
// Service calls run against the in-page mock (no network). They prove the preview's rules, not server security.

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
const svcCall = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(async ([fn, args]) => {
  const { svc } = await import("/js/" + "service.js");
  try { return { ok: true, value: await (svc as any)[fn as string](...(args as unknown[])) }; } catch (e: any) { return { ok: false, code: e.code, message: e.message }; }
}, [fn, args] as const);
const as = (page: Page, uid: string) => page.evaluate(async (uid) => { const { svc } = await import("/js/" + "service.js"); svc.switchUser(uid); }, uid);
const inbox = async (page: Page, uid: string, re: RegExp) => { await as(page, uid);
  return ((await svcCall(page, "notifications")).value as any[]).filter((n) => re.test(n.text)).length; };
const status = (page: Page) => page.locator(".room-head [data-status]");

test.beforeEach(() => { test.skip(proj() === "android-360", "runs at 430 and 1440"); });

test("social review: submit, changes requested, resubmit, approve; no self-review, stale or duplicate decisions", async ({ page, context }) => {
  await open(page, "social");
  const draft = page.locator("article.card[data-post=s_launch]");
  await expect(draft.locator(".status").first()).toHaveText("Draft");
  await expect(draft.locator(".post-roles dd").nth(0)).toHaveText("Northwind Roasters"); // owner
  await expect(draft.locator(".post-roles dd").nth(1)).toHaveText("Jordan Lee");         // creator
  await expect(draft.locator(".post-roles dd").nth(3)).toHaveText("Not reviewed yet");   // reviewer
  expect(await svcCall(page, "reviewPost", "s_launch", "approve", "", 1)).toMatchObject({ ok: false, code: 409 }); // must be submitted first
  await draft.getByRole("button", { name: "Submit for review" }).click();
  await expect(draft.locator(".status").first()).toHaveText("Submitted");
  await expect(draft.getByRole("button", { name: "Approve" })).toHaveCount(0); // no self-review
  expect(await svcCall(page, "reviewPost", "s_launch", "approve", "", 1)).toMatchObject({ ok: false, code: 403 });
  expect(await inbox(page, "u_admin", /waiting for your review/)).toBe(1);
  await as(page, "u_sam");
  expect(await svcCall(page, "reviewPost", "s_launch", "approve", "", 1)).toMatchObject({ ok: false, code: 403 }); // editors don't review social
  await as(page, "u_priya");
  expect(((await svcCall(page, "posts")).value as any[]).some((p) => p.id === "s_launch")).toBe(false);     // another workspace can't see it

  // Avery requests changes with a comment (a comment is required)
  await asRole(page, "u_admin");
  await open(page, "social");
  const card = page.locator("article.card[data-post=s_launch]");
  await card.getByRole("button", { name: "Request changes" }).click();
  await card.getByRole("button", { name: "Send to the author" }).click();
  await expect(page.getByText("Say what should change")).toBeVisible();
  await card.getByLabel("What should change?").fill("Lead with the roastery, not the bag.");
  await card.getByRole("button", { name: "Send to the author" }).click();
  await expect(card.locator(".status").first()).toHaveText("Changes requested");
  expect(await inbox(page, "u_jordan", /Changes requested on the social draft/)).toBe(1);

  // Jordan revises (revision 2) and resubmits; the reviewer's comment stays on record
  await asRole(page, "u_jordan");
  await open(page, "social");
  await expect(card.locator(".post-feedback")).toContainText("Lead with the roastery");
  await card.getByLabel("linkedin caption").fill("From the roastery floor: our spring single-origin line.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("revision 2");
  await card.getByRole("button", { name: "Resubmit for review" }).click();
  await expect(card.locator(".status").first()).toHaveText("Submitted");

  // A second tab approves; this tab's stale approval is refused, and the screen updates
  await asRole(page, "u_admin");
  await open(page, "social");
  const other = await context.newPage();
  await open(other, "social");
  await other.locator("article.card[data-post=s_launch]").getByRole("button", { name: "Approve" }).click();
  await expect(other.locator("article.card[data-post=s_launch] .status").first()).toHaveText("Approved");
  await expect(page.getByText("Updated with changes from another tab")).toBeVisible();
  expect(await svcCall(page, "reviewPost", "s_launch", "approve", "", 2)).toMatchObject({ ok: false, code: 409 });
  expect(await svcCall(page, "submitPost", "s_launch", 2)).toMatchObject({ ok: false, code: 409 });
  await expect(page.locator("article.card[data-post=s_launch] .status").first()).toHaveText("Approved");
  await page.locator("article.card[data-post=s_launch] details summary").click();
  for (const t of ["Created draft", "Submitted for review", "Requested changes", "Revised after feedback", "Approved"]) await expect(page.locator("article.card[data-post=s_launch] details")).toContainText(t);
  // Prepared for publishing, never Published
  await page.locator("article.card[data-post=s_launch]").getByRole("button", { name: "Prepare for publishing" }).click();
  await expect(page.locator("article.card[data-post=s_launch]")).toContainText("Not published");
  await expect(page.locator(".pipe-step", { hasText: "Published" }).locator("b")).toHaveText("0");
  expect(await svcCall(page, "schedulePost", "s_launch")).toMatchObject({ ok: false, code: 409 }); // not twice
  await page.reload();
  await expect(page.locator("article.card[data-post=s_launch] .status").first()).toHaveText("Prepared for publishing"); // persists
});

test("revision rounds: comments are free; one round per version; exhaustion; ask; admin override with reason", async ({ page }) => {
  await open(page, "video-v_launch");
  const block = page.getByLabel("Revision rounds");
  await expect(block).toContainText("1 of 3 used");
  await expect(block).toContainText("2 left");
  await svcCall(page, "addComment", "rv_launch", { version: 2, t: 4, body: "Just a note" }); // comments never use rounds
  await page.reload();
  await expect(block).toContainText("1 of 3 used");
  // Round 2 on version 2; a duplicate request on the same version is refused and not charged
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByLabel("What should change?").fill("Hold the bag shot longer");
  await page.getByRole("button", { name: "Send to the editor" }).click();
  await expect(status(page)).toHaveText("Changes requested");
  expect(await svcCall(page, "decide", "rv_launch", "changes", "again", 2)).toMatchObject({ ok: false, code: 409 });
  // Sam submits v3; Jordan uses the last included round; Sam submits v4
  await as(page, "u_sam"); await svcCall(page, "startRequest", "r_launch"); await svcCall(page, "uploadVersion", "rv_launch", "v3");
  await as(page, "u_jordan"); expect(await svcCall(page, "decide", "rv_launch", "changes", "Warmer grade", 3)).toMatchObject({ ok: true });
  await as(page, "u_sam"); await svcCall(page, "startRequest", "r_launch"); await svcCall(page, "uploadVersion", "rv_launch", "v4");
  await as(page, "u_jordan");
  await page.reload();
  await expect(block).toContainText("3 of 3 used");
  await expect(block).toContainText("None left");
  await expect(page.getByRole("button", { name: "Request changes" })).toBeDisabled();
  expect(await svcCall(page, "decide", "rv_launch", "changes", "one more", 4)).toMatchObject({ ok: false, code: 409 });
  // Jordan asks; Avery is told
  await page.getByLabel("Ask your producer for an extra round").fill("The new label artwork arrived");
  await page.getByRole("button", { name: "Ask for an extra round" }).click();
  await expect(block).toContainText("Extra round asked for");
  expect(await inbox(page, "u_admin", /asked for an extra revision round/)).toBe(1);
  await as(page, "u_jordan");
  expect(await svcCall(page, "grantExtraRound", "rv_launch", "please", 1)).toMatchObject({ ok: false, code: 403 }); // clients can't approve rounds
  // Avery approves one extra round; a reason is required; a stale second approval is refused
  await asRole(page, "u_admin");
  await open(page, "video-v_launch");
  await page.getByLabel("Reason for the extra round").fill("");
  await page.getByRole("button", { name: "Approve 1 extra round" }).click();
  await expect(page.getByText("Give a reason")).toBeVisible();
  await page.getByLabel("Reason for the extra round").fill("Label artwork changed after the brief");
  await page.getByRole("button", { name: "Approve 1 extra round" }).click();
  await expect(block).toContainText("+1 additional");
  await expect(block).toContainText("Label artwork changed after the brief");
  expect(await svcCall(page, "grantExtraRound", "rv_launch", "again", 1, 3)).toMatchObject({ ok: false, code: 409 }); // stale total
  expect(await inbox(page, "u_jordan", /additional revision round/)).toBe(1);
  expect(await inbox(page, "u_sam", /additional revision round/)).toBe(1);
  expect(await inbox(page, "u_priya", /additional revision round/)).toBe(0);
  // Jordan can request changes again; that round is the additional one
  await asRole(page, "u_jordan");
  await open(page, "video-v_launch");
  await expect(block).toContainText("3 of 4 used");
  await expect(block).toContainText("3 included");
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByLabel("What should change?").fill("Swap in the new label");
  await page.getByRole("button", { name: "Send to the editor" }).click();
  await expect(status(page)).toHaveText("Changes requested");
  const rounds = ((await svcCall(page, "video", "v_launch")).value as any).revisions;
  expect(rounds.rounds.map((r: any) => r.kind)).toEqual(["included", "included", "included", "additional"]);
  await open(page, "project-p_launch");
  await expect(page.getByRole("region", { name: "Project activity" })).toContainText("approved 1 additional revision round(s)");
  // Clients and editors can't approve extra rounds
  await as(page, "u_sam");
  expect(await svcCall(page, "grantExtraRound", "rv_launch", "please", 1)).toMatchObject({ ok: false, code: 403 });
});

test("target dates: admin changes with reason; activity; notifications; estimates; stale and unauthorized changes refused", async ({ page, context }) => {
  await asRole(page, "u_admin");
  await open(page, "studio-board");
  const row = page.locator(".board-row[data-request=r_launch]");
  await row.getByRole("button", { name: /Change target date/ }).click();
  const sheet = page.getByRole("dialog", { name: "Change target date" });
  await sheet.getByLabel("New target date").fill("2027-01-15");
  await sheet.getByLabel(/Reason/).fill("Waiting on new label artwork");
  // Another tab changes the date first: this one's save is refused instead of overwriting it
  const other = await context.newPage();
  await open(other, "video-v_launch");
  expect(await svcCall(other, "setDue", "r_launch", "2027-01-10", "Earlier slot", 0)).toMatchObject({ ok: true });
  await sheet.getByRole("button", { name: "Save target date" }).click();
  await expect(page.getByText("Someone changed this date")).toBeVisible();
  await row.getByRole("button", { name: /Change target date/ }).click();
  await page.getByRole("dialog", { name: "Change target date" }).getByLabel("New target date").fill("2027-01-15");
  await page.getByRole("dialog", { name: "Change target date" }).getByLabel(/Reason/).fill("Waiting on new label artwork");
  await page.getByRole("dialog", { name: "Change target date" }).getByRole("button", { name: "Save target date" }).click();
  await expect(page.getByText("Target date changed")).toBeVisible();
  await expect(row).toContainText("target Jan 15");
  await open(page, "project-p_launch");
  await expect(page.getByRole("region", { name: "Project activity" })).toContainText("changed target date");
  await expect(page.getByRole("region", { name: "Project activity" })).toContainText("Waiting on new label artwork");
  expect(await inbox(page, "u_sam", /moved to Jan 15 \(an estimate\)/)).toBe(1);
  expect(await inbox(page, "u_jordan", /moved to Jan 15/)).toBe(1);
  expect(await inbox(page, "u_mika", /moved to Jan 15/)).toBe(0);
  expect(await inbox(page, "u_priya", /moved to Jan 15/)).toBe(0);
  // Clients see the estimate but can't change it; editors can't either; other clients can't see the room
  await asRole(page, "u_jordan");
  await open(page, "video-v_launch");
  await expect(page.locator(".room-head")).toContainText("Target Jan 15 (estimate)");
  await expect(page.getByRole("button", { name: /target date/i })).toHaveCount(0);
  expect(await svcCall(page, "setDue", "r_launch", "2027-02-01", "", 2)).toMatchObject({ ok: false, code: 403 });
  await as(page, "u_sam");
  expect(await svcCall(page, "setDue", "r_launch", "2027-02-01", "", 2)).toMatchObject({ ok: false, code: 403 });
  await as(page, "u_priya");
  expect(await svcCall(page, "video", "v_launch")).toMatchObject({ ok: false, code: 403 });
});

test("workload: assignments, overdue and at-risk update the board", async ({ page }) => {
  await asRole(page, "u_admin");
  await open(page, "studio-board");
  const mika = page.locator(".item", { hasText: "Mika Chen" }).first();
  await expect(mika).toContainText("1 open");
  const r = await svcCall(page, "createRequest", { projectId: "p_reels", type: "short", title: "Workload probe", brief: "B", key: "wl-1" });
  const rid = (r.value as any).id;
  await svcCall(page, "assignRequest", rid, "u_mika");
  const today = new Date(), iso = (d: number) => new Date(today.getTime() + d * 864e5).toISOString().slice(0, 10);
  await svcCall(page, "setDue", rid, iso(1), "Tight turnaround", 0);
  await page.reload();
  await expect(mika).toContainText("2 open");
  await expect(mika).toContainText("1 at risk");
  await expect(page.locator(`.board-row[data-request=${rid}]`)).toContainText("At risk");
  await svcCall(page, "setDue", rid, iso(-2), "Slipped", 1);
  await page.reload();
  await expect(page.locator(`.board-row[data-request=${rid}]`)).toContainText("Overdue");
  await expect(page.locator("[data-editor=u_mika]")).toHaveText("Behind");
  expect(await inbox(page, "u_mika", /Workload probe/)).toBeGreaterThanOrEqual(3); // assigned + two date changes
});

test("migration: a saved demo from the previous preview carries on without silent blocks", async ({ page }) => {
  await open(page, "home");
  // Rebuild a version 5 state (the previous preview's shape) and load it
  await page.evaluate(async () => {
    const { seed } = await import("/js/" + "data.js");
    const s: any = seed(); s.version = 5;
    s.projects.forEach((p: any) => { p.revisionLimit = p.revisionsIncluded ?? 3; delete p.revisionsIncluded; });
    s.projects.find((p: any) => p.id === "p_podcast").revisionLimit = 2;
    s.requests.forEach((r: any) => { delete r.dueRev; delete r.dueHistory; r.revisionsUsed = r.id === "r_launch" ? 1 : r.id === "r_pod" ? 3 : 0; });
    s.reviews.forEach((r: any) => { delete r.rounds; delete r.extraRounds; delete r.extraAsks; });
    s.posts.find((p: any) => p.id === "s_launch").status = "Awaiting approval";
    s.posts.forEach((p: any) => { delete p.rev; delete p.submittedBy; delete p.reviewerId; });
    localStorage.setItem("menapoly-cue-studio-demo", JSON.stringify(s));
  });
  await page.reload();
  await open(page, "video-v_launch");
  await expect(page.getByLabel("Revision rounds")).toContainText("1 of 3 used"); // same remaining as before
  await expect(page.getByRole("button", { name: "Request changes" })).toBeEnabled();
  await open(page, "social");
  await expect(page.locator("article.card[data-post=s_launch] .status").first()).toHaveText("Submitted");
  await asRole(page, "u_admin");
  await open(page, "video-v_pod");
  // Harborline had used 3 of 2: the excess is a recorded carry-over, visible, never silent
  await expect(page.getByLabel("Revision rounds")).toContainText("Carried over");
  await expect(page.getByLabel("Revision rounds")).toContainText("3 of 3 used");
});
