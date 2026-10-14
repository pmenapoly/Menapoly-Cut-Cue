import { expect, test } from "@playwright/test";
import { fixture, isMobile, shot } from "./helpers";

// Acceptance: a first-time user uploads a recording, asks for an edit, reviews it, approves and exports,
// without touching a timeline. Runs at desktop, tablet and phone sizes.
test("first-time user: upload → ask Cue → preview → approve → export", async ({ page, request }, info) => {
  const tag = info.project.name;
  const mobile = isMobile(page);
  const tab = async (name: "Cue" | "Preview" | "Files") => {
    if (mobile) await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name }).click();
  };

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Edit by telling Cue/ })).toBeVisible();
  await shot(page, `${tag}-01-dashboard`);

  // Create the project.
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill(`Market Mocha (${tag})`);
  await shot(page, `${tag}-02-new-project`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/project\/\?id=prj_/);
  await expect(page.getByTestId("onboarding-hint")).toContainText("Drop your recording");

  // Upload recording + brief together.
  await page.getByTestId("file-input").first().setInputFiles([fixture("market-mocha-podcast.wav"), fixture("market-mocha-brief.txt")]);
  const files = page.getByRole("list", { name: "Project files" });
  await expect(files.getByText(/Uploading|Analyzing|Transcribing|Waiting|Finding speakers|Ready/).first()).toBeVisible();
  await shot(page, `${tag}-03-processing`);
  await expect(files.getByText("Ready", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(files.getByText("Brief ready")).toBeVisible();

  // Ask Cue with a suggested prompt.
  await tab("Cue");
  const suggestion = page.getByRole("button", { name: "Make a tight rough cut with a hook" });
  await expect(suggestion).toBeVisible({ timeout: 60_000 });
  await suggestion.click();
  const proposal = page.getByTestId("proposal").first();
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await expect(proposal).toContainText("pauses shortened");
  await expect(proposal).toContainText("Brief check");
  await shot(page, `${tag}-04-proposal`);

  // Preview the proposal instantly (no render): playback really advances.
  await proposal.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("preview-banner")).toBeVisible();
  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-playing", "true");
  await expect(page.getByTestId("player-time")).not.toHaveText(/^0:00 \//, { timeout: 15_000 });
  await expect(page.getByTestId("caption")).toBeVisible();
  await shot(page, `${tag}-05-preview`);
  await page.getByTestId("play-toggle").click();

  // Approve.
  await tab("Cue");
  await proposal.getByRole("button", { name: "Approve" }).click();
  await tab("Preview");
  await expect(page.getByTestId("edit-card")).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByText("approved")).toHaveCount(1);

  // Export with a preset and download it.
  await page.getByRole("banner").getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Export for Instagram Reels" }).click();
  await expect(dialog.getByTestId("render-row").first()).toBeVisible();
  await shot(page, `${tag}-06-exporting`);
  const download = dialog.getByRole("link", { name: "Download MP4" }).first();
  await expect(download).toBeVisible({ timeout: 200_000 });
  await shot(page, `${tag}-07-exported`);
  const href = await download.getAttribute("href");
  const file = await request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("video/mp4");
  expect((await file.body()).length).toBeGreaterThan(50_000);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
