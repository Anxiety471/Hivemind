import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(frontendRoot, "..");
const runId = process.env.GITHUB_RUN_ID ?? "local";
const runDirectory = join(tmpdir(), "hivemind-setup-e2e-" + runId);
rmSync(runDirectory, { recursive: true, force: true });
const configPath = join(runDirectory, "hivemind.toml");
const serverBinary = join(repositoryRoot, "target", "debug", "hivemind");

process.env.HIVEMIND_E2E_CONFIG = configPath;

// A second, already configured server (scripted Pi runtime, two groups, two workspaces) for the
// management specs. The first-run spec above needs its own untouched server.
const managedDirectory = join(tmpdir(), "hivemind-managed-e2e-" + runId);
rmSync(managedDirectory, { recursive: true, force: true });
for (const name of ["ws-one", "ws-two", "ws-three"]) mkdirSync(join(managedDirectory, name), { recursive: true });
const managedConfig = join(managedDirectory, "hivemind.toml");
const fixtureRuntime = join(frontendRoot, "e2e", "fixtures", "pi-fixture.py");
chmodSync(fixtureRuntime, 0o755);
writeFileSync(
  managedConfig,
  `[runtime]
pi_binary = "${fixtureRuntime}"
prompt_timeout_secs = 60
idle_timeout_secs = 120

[conversation]
reply_order = ["Engineer", "Reviewer"]

[[personas]]
id = "Engineer"
runtime = "pi"
system_prompt = "You are the Engineer."
workspace = "${join(managedDirectory, "ws-one")}"

[[personas]]
id = "Reviewer"
runtime = "pi"
system_prompt = "You are the Reviewer."
workspace = "${join(managedDirectory, "ws-one")}"

[[groups]]
id = "alpha"
members = ["Engineer"]

[[groups]]
id = "beta"
members = ["Reviewer"]
`,
);
process.env.HIVEMIND_MANAGED_DIR = managedDirectory;
process.env.HIVEMIND_MANAGED_CONFIG = managedConfig;

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
    // Point at a preinstalled Chromium when the pinned Playwright build is not downloaded.
    launchOptions: process.env.HIVEMIND_CHROMIUM ? { executablePath: process.env.HIVEMIND_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: '"' + serverBinary + '" --config "' + managedConfig + '" serve --port 17475',
      cwd: repositoryRoot,
      url: "http://127.0.0.1:17475/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: { HIVEMIND_NO_UPDATE_CHECK: "1" },
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 15174 --strictPort",
      cwd: frontendRoot,
      url: "http://127.0.0.1:15174",
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_HIVEMIND_URL: "http://127.0.0.1:17475" },
    },
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
