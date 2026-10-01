import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(frontendRoot, "..");
const configPath = join(tmpdir(), "hivemind-setup-e2e-" + process.pid, "hivemind.toml");
const serverBinary = join(repositoryRoot, "target", "debug", "hivemind");

process.env.HIVEMIND_E2E_CONFIG = configPath;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
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
