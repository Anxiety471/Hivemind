import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function listFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(full));
    } else if (
      /\.(ts|mts|js|mjs)$/.test(entry.name) &&
      !/\.(test|test-support)\./.test(entry.name)
    ) {
      results.push(full);
    }
  }
  return results;
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`));
  assert.ok(match, `Missing numeric constant ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

test("esbuild and quickjs-emscripten stay lazily imported in packages/adapters/src", () => {
  const baseDir = path.join(root, "packages/adapters/src");
  const staticImport = /^\s*import\s+(?!type\b)[^;]*?["'](esbuild|quickjs-emscripten)["']/gm;
  const requireCall = /\brequire\s*\(\s*["'](esbuild|quickjs-emscripten)["']\s*\)/g;
  for (const file of listFiles(baseDir)) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    assert.equal(
      staticImport.test(text),
      false,
      `${rel} statically imports esbuild or quickjs-emscripten`,
    );
    assert.equal(requireCall.test(text), false, `${rel} require()s esbuild or quickjs-emscripten`);
  }
});

test("code-mode-sandbox uses event-driven settlement without polling timers", () => {
  const sandbox = read("packages/adapters/src/tools/code-mode-sandbox.ts");
  assert.equal(
    /\babortableDelay\b/.test(sandbox),
    false,
    "abortableDelay must not be used in code-mode-sandbox.ts",
  );
  assert.equal(
    /\bsetTimeout\b/.test(sandbox),
    false,
    "setTimeout must not be used in code-mode-sandbox.ts",
  );
});

test("every vm.newString in code-mode-sandbox is consumed immediately", () => {
  const sandbox = read("packages/adapters/src/tools/code-mode-sandbox.ts");
  const allNewStrings = [...sandbox.matchAll(/\bvm\.newString\s*\(/g)];
  const consumedNewStrings = [...sandbox.matchAll(/\bvm\.newString\([^)]*\)\.consume\(/g)];
  assert.ok(allNewStrings.length > 0, "Expected vm.newString calls in code-mode-sandbox.ts");
  assert.equal(
    allNewStrings.length,
    consumedNewStrings.length,
    "Every vm.newString(...) in code-mode-sandbox.ts must chain .consume(...) to avoid handle leaks",
  );
});

test("CODE_MODE_SHELL_TIMEOUT_MS stays strictly below CODE_MODE_TIMEOUT_MS", () => {
  const def = read("packages/adapters/src/tools/code-mode.tool-definition.ts");
  const sandbox = read("packages/adapters/src/tools/code-mode-sandbox.ts");
  const shellTimeout = numericConstant(def, "CODE_MODE_SHELL_TIMEOUT_MS");
  const scriptTimeout = numericConstant(sandbox, "CODE_MODE_TIMEOUT_MS");
  assert.ok(
    shellTimeout < scriptTimeout,
    `CODE_MODE_SHELL_TIMEOUT_MS (${shellTimeout}) must be < CODE_MODE_TIMEOUT_MS (${scriptTimeout})`,
  );
});

test("code_mode is registered across tool selection, bridge, and contracts", () => {
  const selection = read("packages/adapters/src/runs/tools/run-tool-selection.ts");
  const bridge = read("packages/adapters/src/tools/builtin-tool-bridge.ts");
  const contracts = read("packages/contracts/src/bots/builtin-tools.ts");

  assert.match(selection, /READ_ONLY_AGENT_TOOLS\s*=\s*new Set\(\[[\s\S]*?\bCODE_MODE\b/);
  assert.match(selection, /CODE_MODE_EXCLUDED_TOOLS[\s\S]*?\[CODE_MODE\]:\s*true/);
  assert.match(bridge, /CORE_BUILTIN_TOOL_NAMES[\s\S]*?\bCODE_MODE\b/);
  assert.match(contracts, /["']code_mode["']/);
});

test("saved commands use globals injection instead of interpolating args into TypeScript", () => {
  const runTools = read("packages/adapters/src/runs/tools/run-tools.ts");
  assert.match(runTools, /\bcodeCommandBodyScript\s*\(/);
  assert.equal(/\bcodeCommandScript\s*\(/.test(runTools), false);
});

test("command_save lints and syntax-checks commands before saving", () => {
  const commands = read("packages/adapters/src/runs/tools/run-tools-commands.ts");
  const lintIdx = commands.indexOf("lintCodeModeScript(");
  const syntaxIdx = commands.indexOf("checkCodeModeSyntax(");
  const saveIdx = commands.indexOf("saveCodeCommand(");
  assert.ok(
    lintIdx > 0 && syntaxIdx > 0 && saveIdx > 0,
    "Expected lint, syntax check, and saveCodeCommand",
  );
  assert.ok(
    lintIdx < saveIdx && syntaxIdx < saveIdx,
    "Lint and syntax check must run before saveCodeCommand",
  );
});
