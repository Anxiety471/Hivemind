import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(frontendRoot, "..");
const runId = process.env.GITHUB_RUN_ID ?? "local";
const runDirectory = join(tmpdir(), "hivemind-setup-e2e-" + runId);
rmSync(runDirectory, { recursive: true, force: true });
const configPath = join(runDirectory, "hivemind.toml");
const serverBinary = join(repositoryRoot, "target", "debug", "hivemind");

process.env.HIVEMIND_E2E_CONFIG = configPath;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Setup is intentionally one-shot, so a retry against the same server cannot
  // start from the same initial state after a partially successful attempt.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:15173",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: '"' + serverBinary + '" --config "' + configPath + '" serve --port 17474',
      cwd: repositoryRoot,
      url: "http://127.0.0.1:17474/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { HIVEMIND_NO_UPDATE_CHECK: "1" },
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 15173 --strictPort",
      cwd: frontendRoot,
      url: "http://127.0.0.1:15173",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { VITE_HIVEMIND_URL: "http://127.0.0.1:17474" },
    },
  ],
});
