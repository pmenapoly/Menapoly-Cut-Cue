import { defineConfig, devices } from "@playwright/test";

// Menapoly Cue Studio preview (studio-preview/): static files + fictional fixtures, served locally.
// Nothing here talks to the production pilot, Cloudflare or any external service.
const PORT = 8798;
export default defineConfig({
  testDir: "./e2e-studio",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    launchOptions: { args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] },
  },
  projects: [
    { name: "android-360", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } },
    { name: "android-430", use: { ...devices["Pixel 7"], viewport: { width: 430, height: 932 } } },
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `python3 ../studio-preview/tools/serve.py --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
