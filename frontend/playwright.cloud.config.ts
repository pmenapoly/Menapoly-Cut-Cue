import { defineConfig, devices } from "@playwright/test";

// Mobile tests of the cloud app (cloud/web) against the real control-plane Worker under wrangler dev, moto standing
// in for private R2, and the real Mac agent started by the tests. Nothing reaches Cloudflare. `make cloud-ui-test`.
const PORT = 8790;
export default defineConfig({
  testDir: "./e2e-cloud",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    serviceWorkers: "block", // page.route() cannot see requests from a service-worker-controlled page
    launchOptions: { args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] },
  },
  projects: [
    { name: "phone-390", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `../backend/.venv/bin/python ../scripts/cloud_dev.py --port ${PORT} --state-file e2e-cloud/.stack.json --fixture-dir e2e-cloud/.fixtures`,
    url: `http://localhost:${PORT}/v1/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
  },
});
