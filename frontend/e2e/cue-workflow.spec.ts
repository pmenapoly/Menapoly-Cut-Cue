import { expect, test } from "@playwright/test";
import { apiUpload, fixture, projectWithEdit, shot, waitIdle } from "./helpers";

// The first real Cue 2.0 workflow end to end against the real backend: Ask Cue proposes → owner approves →
// Cut Cue proposal → real render → client review link → client requests changes → owner is notified → revision.
test("Ask Cue proposes, owner approves, Cut Cue drafts the edit", async ({ page, request }, info) => {
  const name = `Ask Flow ${info.project.name}`;
  const p = await (await request.post("/api/cue/projects", { data: { name, client: "Mocha Co" } })).json();
  await apiUpload(request, p.id, fixture("market-mocha-podcast.wav"));
  await waitIdle(request, p.id);

  await page.goto("/");
  const ask = page.getByRole("region", { name: "Ask Cue" }).or(page.locator('section[aria-label="Ask Cue"]')).first();
  await ask.getByLabel("Message Cue").fill(`Make a rough cut of ${name}`);
  await ask.getByRole("button", { name: "Send" }).click();
  const card = ask.getByTestId("action-card").last();
  await expect(card).toHaveAttribute("data-status", "proposed");
  await expect(card).toContainText("Proposed · needs your approval");
  await expect(ask).toContainText("Local mode");
  // Nothing happened yet.
  expect((await (await request.get(`/api/projects/${p.id}/proposals`)).json())).toHaveLength(0);
  await shot(page, `cue2-${info.project.name}-ask-proposed`);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveAttribute("data-status", "executed");
  await expect(card).toContainText("Approved and done");
  const proposals = await (await request.get(`/api/projects/${p.id}/proposals`)).json();
  expect(proposals).toHaveLength(1);
  expect(proposals[0].status).toBe("pending");
  await card.getByRole("link", { name: /Open/ }).click();
  await expect(page).toHaveURL(new RegExp(`/project/\\?id=${p.id}`));
  await expect(page.getByRole("radiogroup", { name: "Editing mode" })).toBeVisible();
});

test("client review link: client requests changes, owner is notified and prepares a revision", async ({ page, request, browser }, info) => {
  const { pid } = await projectWithEdit(request, `Review Flow ${info.project.name}`);
  await waitIdle(request, pid); // the approved edit's preview render really finishes
  await page.goto(`/projects/?id=${pid}&tab=reviews`);
  await page.getByRole("button", { name: "Create review link" }).click();
  await expect(page.getByText("Anyone with this link can watch")).toBeVisible();
  await page.getByRole("button", { name: "Yes, create link" }).click();
  const url = await page.getByLabel("Review link", { exact: true }).inputValue();
  expect(url).toMatch(/\/review\/\?t=rv_/);
  await shot(page, `cue2-${info.project.name}-review-link`);

  // The client: a separate browser context with no owner session.
  const client = await browser.newContext({ viewport: info.project.name === "mobile" ? { width: 375, height: 812 } : undefined });
  const cp = await client.newPage();
  await cp.goto(url);
  await expect(cp.getByRole("heading", { name: `Review Flow ${info.project.name}` })).toBeVisible();
  await expect(cp.getByTestId("review-video")).toBeVisible();
  await cp.getByLabel("Your name").fill("Dana");
  await cp.getByLabel("Note", { exact: true }).fill("Please cut the part about pricing");
  await cp.getByRole("button", { name: "Request changes" }).click();
  await cp.getByRole("button", { name: "Confirm" }).click();
  await expect(cp.getByRole("status")).toContainText("The editor will work on your changes");
  await expect(cp.getByText("Changes requested by Dana")).toBeVisible();
  const overflow = await cp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await cp.screenshot({ path: `../docs/screenshots/cue2-${info.project.name}-client-review.png` });
  await client.close();

  // The owner: notification + open note + revision proposal.
  await page.reload();
  await expect(page.getByTestId("bell")).toHaveAccessibleName(/unread/);
  await page.getByTestId("bell").click();
  const notes = page.getByRole("dialog", { name: "Notifications" });
  await expect(notes.getByRole("button", { name: new RegExp(`Dana requested changes.*Review Flow ${info.project.name}`) })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Client notes" })).toContainText("cut the part about pricing");
  await page.getByRole("button", { name: "Prepare a revision" }).click();
  const card = page.getByTestId("action-card").first();
  await expect(card).toHaveAttribute("data-status", "proposed");
  await expect(card).toContainText("Uses AI budget");
  // Serious actions need a second confirmation; dismiss instead.
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveAttribute("data-status", "rejected");
});

test("Cue Text simulator: approved sender's text becomes an approval in Inbox", async ({ page }, info) => {
  test.skip(info.project.name === "tablet", "covered on desktop and mobile");
  const phone = info.project.name === "mobile" ? "+15550001111" : "+15550002222";
  await page.goto("/settings/");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByLabel("Name", { exact: true }).fill("Owner phone");
  await expect(page.getByRole("button", { name: "Add" })).toBeDisabled(); // consent first
  await page.getByLabel(/agreed to text with Menapoly Cue/).check();
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Approved senders" })).toContainText(phone.slice(2));
  await page.getByLabel("From number").fill(phone);
  await page.getByLabel("Text", { exact: true }).fill(`new project Texted ${info.project.name}`);
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByRole("status").filter({ hasText: "action proposed" })).toBeVisible();
  await page.goto("/inbox/?tab=approvals");
  const card = page.getByTestId("action-card").filter({ hasText: `Texted ${info.project.name}` }).first();
  await expect(card).toContainText("from a text");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveAttribute("data-status", "executed");
  await page.goto("/inbox/?tab=messages");
  await expect(page.getByText("Draft reply — not sent").first()).toBeVisible();
  await shot(page, `cue2-${info.project.name}-texts`);
});
