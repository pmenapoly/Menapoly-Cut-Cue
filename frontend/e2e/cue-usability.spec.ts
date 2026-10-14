import { expect, test } from "@playwright/test";
import { projectWithEdit, shot } from "./helpers";

// Usability round: searchable shortcut guide, keyboard navigation, a clear way out of the editor,
// upload-first for new projects, and honest delivery/notification settings.
test("searchable keyboard shortcut guide and G-then-letter navigation", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "hardware keyboard");
  await page.goto("/");
  await expect(page.getByText("What should we make today?")).toBeVisible();
  await page.keyboard.press("Shift+?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Cue Pro timeline" })).toBeVisible();
  await dialog.getByLabel("Search shortcuts").fill("split");
  await expect(dialog.getByText("Split at the playhead")).toBeVisible();
  await expect(dialog.getByText("Play / pause")).toHaveCount(0);
  await dialog.getByLabel("Search shortcuts").fill("zzzz");
  await expect(dialog.getByText(/No shortcut matches/)).toBeVisible();
  await shot(page, `cue2-${info.project.name}-shortcuts`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page).toHaveURL(/\/inbox\/$/);
  await expect(page.getByRole("tablist", { name: "Inbox sections" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("p");
  await expect(page).toHaveURL(/\/projects\/$/);
  // Typing in a field never triggers navigation.
  await page.getByLabel("Search projects").fill("gi");
  await expect(page).toHaveURL(/\/projects\/$/);
});

test("new project: upload area first, and a clear way back from the editor", async ({ page, request }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill(`Usability ${info.project.name}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/project\/\?id=prj_/);
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(page.getByRole("region", { name: "Preview" })).toBeHidden(); // no empty player above the fold
    const upload = await page.getByRole("button", { name: "Choose files" }).first().boundingBox();
    expect(upload!.y).toBeLessThan(500);
  } else if ((page.viewportSize()?.width ?? 0) < 640) {
    await expect(page.getByText(/Step 2 of 7: Upload/)).toBeVisible();
  }
  await shot(page, `cue2-${info.project.name}-new-project`);
  await page.getByTestId("editor-back").click();
  await expect(page).toHaveURL(/\/projects\/\?id=prj_/);
  await expect(page.getByTestId("project-title")).toHaveText(`Usability ${info.project.name}`);
});

test("editor: ? opens the same searchable guide", async ({ page, request }, info) => {
  test.skip(info.project.name === "mobile", "hardware keyboard");
  const { pid } = await projectWithEdit(request, `Keys guide ${info.project.name}`);
  await page.goto(`/project/?id=${pid}&mode=simple`);
  await page.getByRole("radiogroup", { name: "Editing mode" }).waitFor();
  const sections = page.getByRole("navigation", { name: "Sections" });
  if (await sections.isVisible()) await sections.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("play-toggle")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Keyboard shortcuts (?)" }).first().click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("delivery and settings explain what is and isn't connected", async ({ page, request }, info) => {
  const p = await (await request.post("/api/cue/projects", { data: { name: `Delivery ${info.project.name}` } })).json();
  await page.goto(`/projects/?id=${p.id}&tab=delivery`);
  await expect(page.getByRole("region", { name: "Client portal" })).toContainText("Not connected");
  await page.goto("/settings/");
  await expect(page.getByText("Email is off")).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText(/Backed up: cutcue-backup-/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Backups" })).toContainText("database only");
  await shot(page, `cue2-${info.project.name}-settings`);
});
