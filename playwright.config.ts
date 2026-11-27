import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 5180);
const createdHome = process.env.SUKUNA_E2E_HOME ? "" : mkdtempSync(join(tmpdir(), "sukuna-e2e-"));
if (createdHome) process.env.SUKUNA_E2E_HOME = createdHome;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bash e2e/start-server.sh ${port}`,
    env: { SUKUNA_E2E_CREATED_HOME: createdHome },
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 25_000 },
    timeout: 120_000,
  },
});
