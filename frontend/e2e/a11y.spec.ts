import { expect, Page, test } from "@playwright/test";
import { projectWithEdit } from "./helpers";

/** Every visible interactive element must have an accessible name. */
async function unnamedControls(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const name = (el: HTMLElement) => {
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el.labels?.length) return Array.from(el.labels).map((l) => l.textContent).join(" ");
        return el.getAttribute("placeholder") || el.getAttribute("title");
      }
      return el.textContent?.trim() || el.getAttribute("title");
    };
    return Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [role=slider]"))
      .filter((el) => visible(el) && !(el as HTMLInputElement).hidden && !(name(el) ?? "").trim())
      .map((el) => el.outerHTML.slice(0, 140));
  });
}

test("dashboard and workspace controls all have accessible names", async ({ page, request }, info) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New project" }).first()).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);
  const { pid } = await projectWithEdit(request, `A11y (${info.project.name})`);
  await page.goto(`/project/?id=${pid}&mode=simple`);
  await page.getByRole("radiogroup", { name: "Editing mode" }).waitFor();
  const sections = page.getByRole("navigation", { name: "Sections" });
  if (await sections.isVisible()) {
    for (const tab of ["Cue", "Files", "Preview"]) {
      await sections.getByRole("button", { name: tab }).click();
      expect(await unnamedControls(page), tab).toEqual([]);
    }
  }
  await expect(page.getByTestId("play-toggle")).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);
  if (info.project.name !== "mobile") {
    await page.getByRole("radio", { name: "Pro" }).click();
    await expect(page.getByTestId("timeline")).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
  }
});

test("keyboard: skip link, dialog focus trap and Escape, player shortcuts", async ({ page, request }, info) => {
  test.skip(info.project.name === "mobile", "hardware keyboard flows");
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  // Dialog traps focus and returns it on Escape.
  const opener = page.getByRole("banner").getByRole("button", { name: "New project" }).or(page.getByRole("button", { name: "New project" }).first()).first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Player shortcuts: Space/K play-pause, L/J seek.
  const { pid } = await projectWithEdit(request, `Keys (${info.project.name})`);
  await page.goto(`/project/?id=${pid}&mode=simple`);
  await page.getByRole("radiogroup", { name: "Editing mode" }).waitFor();
  const sections = page.getByRole("navigation", { name: "Sections" });
  if (await sections.isVisible()) await sections.getByRole("button", { name: "Preview" }).click();
  const toggle = page.getByTestId("play-toggle");
  await expect(toggle).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("l");
  await expect(page.getByTestId("player-time")).toHaveText(/^0:05/);
  await page.keyboard.press("j");
  await expect(page.getByTestId("player-time")).toHaveText(/^0:00/);
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-playing", "true");
  await page.keyboard.press("k");
  await expect(toggle).toHaveAttribute("data-playing", "false");
});

test("no horizontal scrolling at this screen size", async ({ page, request }, info) => {
  const { pid } = await projectWithEdit(request, `Layout (${info.project.name})`);
  for (const url of ["/", `/project/?id=${pid}&mode=simple`, `/project/?id=${pid}&mode=pro`]) {
    await page.goto(url);
    await page.waitForTimeout(1200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
});
