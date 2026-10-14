import { expect, Page, test } from "@playwright/test";
import { projectWithEdit, shot } from "./helpers";

// Cue Pro: professional editing on the same project state as Cue Simple (desktop and tablet).
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name === "mobile", "Cue Pro targets tablet and desktop; phones use Cue Simple");
});

const clips = (page: Page) => page.getByTestId("clip");
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("timeline editing: split, delete, undo/redo, reorder, trim, save, history", async ({ page, request }, info) => {
  const { pid, seq } = await projectWithEdit(request, `Pro (${info.project.name})`);
  const start = seq.timeline.clips.length;
  await page.goto(`/project/?id=${pid}&mode=pro`);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(clips(page)).toHaveCount(start);
  // Audio waveforms and caption cues are drawn.
  await expect(page.getByTestId("timeline").locator("svg path").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("timeline").getByRole("button").filter({ hasText: /\w/ }).first()).toBeVisible();
  await shot(page, `${info.project.name}-08-pro`);

  // Move the playhead to 5 s from the keyboard and split there (S).
  const ruler = page.getByRole("slider", { name: "Timeline position" });
  await ruler.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("s");
  await expect(clips(page)).toHaveCount(start + 1);

  // Select the first cut and delete it.
  await clips(page).first().focus();
  await expect(clips(page).first()).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Delete");
  await expect(clips(page)).toHaveCount(start);
  await expect(page.getByTestId("save-version")).toBeEnabled();

  // Undo / redo (local draft history).
  await page.keyboard.press(`${mod}+z`);
  await expect(clips(page)).toHaveCount(start + 1);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(clips(page)).toHaveCount(start);
  await page.keyboard.press(`${mod}+z`);
  await expect(clips(page)).toHaveCount(start + 1);

  // Reorder with Alt+Arrow.
  const describe = async (i: number) => (await clips(page).nth(i).getAttribute("aria-label"))!.replace(/^Cut \d+: /, "");
  const first = await describe(0);
  await clips(page).nth(0).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => describe(1)).toBe(first);

  // Trim the end of the widest cut by dragging its handle.
  const widths = await clips(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  const widest = widths.indexOf(Math.max(...widths));
  const before = await clips(page).nth(widest).getAttribute("aria-label");
  const handle = clips(page).nth(widest).getByTestId("trim-end");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 25, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(clips(page).nth(widest)).not.toHaveAttribute("aria-label", before!);

  // Save as a new version.
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("save-version")).toHaveText("Saved");
  let saved = (await (await request.get(`/api/projects/${pid}/sequences`)).json())[0];
  expect(saved.versions).toHaveLength(2);
  expect(saved.current_version_id).toBe(saved.versions[1].id);

  // With no unsaved edits, undo steps back through saved versions (and redo forward).
  await page.getByRole("button", { name: "Undo (⌘Z)" }).first().click();
  await expect.poll(async () => (await (await request.get(`/api/projects/${pid}/sequences`)).json())[0].current_version_id).toBe(saved.versions[0].id);
  await expect(clips(page)).toHaveCount(start);
  await page.getByRole("button", { name: "Redo (⇧⌘Z)" }).first().click();
  await expect.poll(async () => (await (await request.get(`/api/projects/${pid}/sequences`)).json())[0].current_version_id).toBe(saved.versions[1].id);

  // Before/after comparison.
  await page.getByRole("button", { name: "History and before/after" }).click();
  const history = page.getByRole("dialog", { name: /History/ });
  await expect(history.getByTestId("compare-view")).toBeVisible();
  await expect(history.getByText(/Length .* →/)).toBeVisible();
  await shot(page, `${info.project.name}-09-before-after`);
  await page.keyboard.press("Escape");

  // Same state in both modes: an unsaved Pro edit is flagged in Cue Simple.
  await page.getByRole("slider", { name: "Timeline position" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("s");
  await page.getByRole("radio", { name: "Simple" }).click();
  await expect(page.getByText("You have unsaved Pro changes")).toBeVisible();
  await page.getByRole("radio", { name: "Pro" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("save-version")).toHaveText("Saved");
});

test("transcript editing: cut a passage, correct wording", async ({ page, request }, info) => {
  const { pid, assetId } = await projectWithEdit(request, `Transcript (${info.project.name})`);
  await page.goto(`/project/?id=${pid}&mode=pro`);
  await expect(page.getByTestId("timeline")).toBeVisible();
  const startCount = await page.getByTestId("clip").count();
  const totalBefore = await page.getByTestId("player-time").textContent();
  await page.getByRole("tab", { name: "Transcript" }).click();

  // Select "we posted one honest video" and cut it from the edit.
  await page.getByText("posted", { exact: true }).first().click();
  await page.getByText("honest", { exact: true }).first().click({ modifiers: ["Shift"] });
  await expect(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
  await page.getByRole("button", { name: "Cut from edit" }).click();
  await expect(page.getByTestId("clip")).toHaveCount(startCount + 1);
  await expect(page.getByTestId("player-time")).not.toHaveText(totalBefore!);
  await expect(page.getByText("posted", { exact: true }).first()).toHaveClass(/line-through/);

  // Fix the wording of the first line; captions follow the transcript.
  await page.getByRole("button", { name: /Correct the wording at/ }).first().click();
  await page.getByLabel("Corrected text").fill("Welcome to the Market Mocha show.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("show.", { exact: true })).toBeVisible();
  const segs = await (await request.get(`/api/projects/${pid}/assets/${assetId}/transcript`)).json();
  expect(segs[0].text).toBe("Welcome to the Market Mocha show.");
  await shot(page, `${info.project.name}-10-transcript`);
});

test("drag a recording from the media bin onto the timeline", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "HTML5 drag-and-drop exercised on desktop");
  const { pid } = await projectWithEdit(request, `Drag (${info.project.name})`);
  await page.goto(`/project/?id=${pid}&mode=pro`);
  await expect(page.getByTestId("clip").first()).toBeVisible();
  const count = await page.getByTestId("clip").count();
  const media = page.getByRole("list", { name: "Project files" }).getByRole("button", { name: /^market-mocha-podcast\.wav/ });
  await media.dragTo(page.getByTestId("timeline").getByTestId("clip").last());
  await expect(page.getByTestId("clip")).toHaveCount(count + 1);
  await expect(page.getByTestId("save-version")).toBeEnabled();
});
