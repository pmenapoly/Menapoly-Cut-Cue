import { defineConfig, devices } from "@playwright/test";

// Browser tests (Android phone widths and desktop Chrome) of the cloud app (cloud/web) against the real control-plane Worker under wrangler dev, moto standing
// in for private R2, and the real Mac agent started by the tests. Nothing reaches Cloudflare. `make cloud-ui-test`.
const PORT = 8790;
export default defineConfig({
  testDir: "./e2e-cloud",
  timeout: 360_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    serviceWorkers: "block", // page.route() cannot see requests from a service-worker-controlled page
    launchOptions: { args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] },
  },
  // Chrome on Android (Pixel 7 profile: Android Chrome user agent, touch, mobile viewport) at the two widths that matter.
  projects: [
    { name: "android-375", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
    { name: "android-430", use: { ...devices["Pixel 7"], viewport: { width: 430, height: 932 } } },
    // Chrome on a desktop (the Intel iMac): mouse, no touch, wide window.
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `../backend/.venv/bin/python ../scripts/cloud_dev.py --port ${PORT} --state-file e2e-cloud/.stack.json --fixture-dir e2e-cloud/.fixtures`,
    url: `http://localhost:${PORT}/v1/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
  },
});
