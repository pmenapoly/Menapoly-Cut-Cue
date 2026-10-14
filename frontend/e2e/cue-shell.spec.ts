import { expect, Page, test } from "@playwright/test";
import { shot } from "./helpers";

// Menapoly Cue 2.0 shell at the five required widths: no horizontal overflow, reachable navigation,
// touch-sized targets, named controls. Runs once (desktop project) and resizes the page itself.
const WIDTHS = [375, 430, 768, 1280, 1440];
const PAGES = ["/", "/projects/", "/cut/", "/inbox/", "/library/", "/settings/", "/gallery/"];

async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
    // Primary navigation and main buttons must be at least 40px tall (most are 44+).
    return Array.from(document.querySelectorAll<HTMLElement>('nav[aria-label="Main"] a, header button, header a'))
      .filter(vis).map((e) => ({ name: e.getAttribute("aria-label") || e.textContent?.trim(), h: Math.round(e.getBoundingClientRect().height),
        w: Math.round(e.getBoundingClientRect().width) }))
      .filter((t) => t.h < 36 || t.w < 36);
  });
}

async function unnamed(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea"))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .filter((el) => {
      const label = el.getAttribute("aria-label") || el.textContent?.trim() || el.getAttribute("title") || el.getAttribute("placeholder")
        || ((el as HTMLInputElement).labels?.length ? "x" : "");
      return !label;
    }).map((el) => el.outerHTML.slice(0, 120)));
}

test("shell is responsive and accessible at 375/430/768/1280/1440", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "resizes itself through all five widths");
  const p = await (await request.post("/api/cue/projects", { data: { name: "Shell check", client: "Acme" } })).json();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 800 ? 860 : 900 });
    for (const path of [...PAGES, `/projects/?id=${p.id}`]) {
      await page.goto(path);
      await expect(page.locator("main#main")).toBeVisible();
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} @${width}`).toBeLessThanOrEqual(1);
      expect(await unnamed(page), `${path} @${width}`).toEqual([]);
    }
    // Exactly one main navigation is visible and every destination is reachable from it.
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toHaveCount(1);
    for (const label of ["Home", "Projects", "Cut Cue", "Inbox", "Library"]) await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    expect(await smallTargets(page), `@${width}`).toEqual([]);
    await nav.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL(/\/library\/$/);
    await expect(nav.getByRole("link", { name: "Library", exact: true })).toHaveAttribute("aria-current", "page");
    if ([375, 768, 1440].includes(width)) {
      await page.goto("/"); await page.waitForLoadState("networkidle");
      await shot(page, `cue2-${width}-home`);
      await page.goto(`/projects/?id=${p.id}`); await page.waitForLoadState("networkidle");
      await shot(page, `cue2-${width}-project`);
    }
  }
});

test("theme toggle switches between light and dark and persists", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one run is enough");
  await page.goto("/settings/");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(17, 18, 27)"); // #11121B
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/");
  await shot(page, "cue2-1440-home-dark");
  await page.goto("/settings/");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(246, 245, 251)");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Device" }).click();
});

test("projects: filter by client, switch views, open details", async ({ page, request }, info) => {
  await request.post("/api/cue/projects", { data: { name: `Filter A (${info.project.name})`, client: `Client A ${info.project.name}` } });
  await request.post("/api/cue/projects", { data: { name: `Filter B (${info.project.name})`, client: `Client B ${info.project.name}` } });
  await page.goto("/projects/");
  await page.getByLabel("Search projects").fill(`Filter A (${info.project.name})`);
  await expect(page.getByRole("link", { name: new RegExp(`Filter A \\(${info.project.name}\\)`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Filter B \\(${info.project.name}\\)`) })).toHaveCount(0);
  await page.getByLabel("Search projects").fill("");
  await page.getByLabel("Client", { exact: true }).selectOption({ label: `Client B ${info.project.name}` });
  await expect(page.getByRole("link", { name: new RegExp(`Filter B \\(${info.project.name}\\)`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Filter A \\(${info.project.name}\\)`) })).toHaveCount(0);
  for (const view of ["Board", "List", "Cards"]) {
    await page.getByRole("radio", { name: view }).click();
    await expect(page.getByRole("link", { name: new RegExp(`Filter B`) }).first()).toBeVisible();
  }
  await page.getByRole("link", { name: new RegExp(`Filter B \\(${info.project.name}\\)`) }).first().click();
  await expect(page.getByTestId("project-title")).toHaveText(`Filter B (${info.project.name})`);
  await page.getByLabel("Stage", { exact: true }).selectOption("approved");
  await expect(page.getByText("Stage updated")).toBeVisible();
  await page.getByRole("tab", { name: "Media" }).click();
  await page.getByRole("button", { name: "Upload from a phone" }).click();
  await expect(page.getByLabel("Upload link")).toHaveValue(/\/upload\/\?t=up_/);
});

