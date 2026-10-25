import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Design checks for the light "Creative Command Center" look: layout at every target width, accessibility (axe, WCAG 2.1 AA)
// and visual regression of the major screens. Fictional data only; the clock is fixed so dates and greetings are stable.

const proj = () => test.info().project.name;
const SHOTS = path.join(__dirname, "..", "..", "docs", "studio", "screenshots", "light");
const FIXED = new Date("2026-10-25T10:00:00");
const SCREENS = [["home", "home"], ["studio", "studio"], ["room-review", "video-v_launch"], ["room-approved", "video-v_reel"], ["visibility", "visibility"]] as const;
const WIDTHS = [[360, 780], [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]] as const;

async function open(page: Page, token: string) {
  await page.goto(`/#${token}`);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(FIXED); await page.emulateMedia({ reducedMotion: "reduce" }); });

test("layout at 360–1440 px: no sideways scroll, no overlaps, Maven reachable, readable text", async ({ page }) => {
  test.skip(proj() !== "android-430", "one sweep covers every width");
  for (const [w, hgt] of WIDTHS) {
    await page.setViewportSize({ width: w, height: hgt });
    for (const [name, token] of SCREENS) {
      await open(page, token);
      const r = await page.evaluate(() => {
        const out: string[] = [];
        if (document.scrollingElement!.scrollWidth > innerWidth) out.push(`sideways scroll ${document.scrollingElement!.scrollWidth} > ${innerWidth}`);
        // header controls never overlap each other (the Maven launcher included)
        const boxes = [...document.querySelectorAll<HTMLElement>(".top-inner > *")].filter((e) => e.offsetWidth && getComputedStyle(e).display !== "none")
          .map((e) => ({ e, b: e.getBoundingClientRect() })).filter((x) => x.b.width > 0);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].b, b = boxes[j].b;
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`header overlap: ${boxes[i].e.className} × ${boxes[j].e.className}`);
        }
        const maven = document.querySelector<HTMLElement>(".maven-btn");
        if (!maven || maven.getBoundingClientRect().height < 44) out.push("Maven launcher missing or under 44 px");
        // nothing visible wider than the screen
        document.querySelectorAll<HTMLElement>("main *").forEach((el) => { const b = el.getBoundingClientRect();
          if (b.width && b.right > innerWidth + 1 && !el.closest(".tabs, .suggestions, .table-wrap, .folders")) out.push(`overflows: ${el.tagName}.${el.className}`.slice(0, 90)); });
        // body text is at least 12 px
        document.querySelectorAll<HTMLElement>("main p, main span, main b, main a, main button").forEach((el) => {
          if (el.offsetWidth && el.textContent?.trim() && !el.closest("svg") && parseFloat(getComputedStyle(el).fontSize) < 11.5) out.push(`tiny text: ${el.textContent.trim().slice(0, 30)}`); });
        return [...new Set(out)];
      });
      expect(r, `${name} at ${w}px`).toEqual([]);
      if (w < 1024) await expect(page.locator(".bar")).toBeVisible(); else await expect(page.locator(".rail")).toBeVisible();
    }
  }
});

test("accessibility: axe finds no WCAG 2.1 AA violations on the major screens", async ({ page }) => {
  test.skip(proj() === "android-360", "430 and 1440 cover phone and desktop");
  for (const [name, token] of [...SCREENS, ["library", "library"], ["ask", "ask"], ["request-new", "request-new"], ["social", "social"]] as const) {
    await open(page, token);
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const v = res.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    expect(v, `${name}`).toEqual([]);
  }
  // The production board (administrator view)
  await open(page, "settings");
  await page.locator("#role-select").selectOption("u_admin");
  await open(page, "studio-board");
  const board = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(board.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), "production board").toEqual([]);
  await open(page, "settings");
  await page.locator("#role-select").selectOption("u_jordan");
  // Maven sheet open over the Editing Room
  await open(page, "video-v_launch");
  await page.getByRole("button", { name: /Ask Maven/ }).click();
  await page.getByRole("button", { name: "Summarize this video" }).click();
  await expect(page.locator(".msg.cue")).toHaveCount(1);
  const res = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.map((x) => x.id), "maven sheet").toEqual([]);
});

test("visual regression: major screens", async ({ page }) => {
  test.skip(proj() === "android-360", "baselines at 430 and 1440");
  fs.mkdirSync(path.join(SHOTS, proj()), { recursive: true });
  for (const [name, token] of SCREENS) {
    await open(page, token);
    await page.waitForTimeout(300); // posters decode
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.02, mask: [page.locator(".vp video")] });
    await page.screenshot({ path: path.join(SHOTS, proj(), `${name}.png`) });
    await page.screenshot({ path: path.join(SHOTS, proj(), `${name}-full.png`), fullPage: true });
  }
});
