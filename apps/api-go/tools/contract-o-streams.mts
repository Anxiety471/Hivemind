/**
 * Contract test for the four live streams: the same fixture is opened as a server-sent event
 * stream on the TypeScript API (in-process, against the fixture database) and through the Go
 * gateway, and the frames each side sends are compared.
 *
 * A stream is never shadowed (a shadow would have to buffer it), so the Go route table must serve
 * all four locally; the harness asserts the gateway log says so.
 *
 * Run from a checkout with node_modules, against a fixture database neither side is serving:
 *   set -a; . /home/hitori/go-port/fixture-db/.env.o-streams; set +a
 *   GO_BINARY=/tmp/rakazo-gateway node_modules/.bin/tsx apps/api-go/tools/contract-o-streams.mts
 *
 * Timing corners: the TypeScript side's heartbeat (20 s), keepalive (5 s) and session re-check
 * (10 s) are module constants, so those cases take real time and both sides are opened at once.
 */
import "./contract-o-streams-env.mts";
import "./contract-o-streams-helpers.mts";
import "./contract-o-streams-cases-a.mts";
import "./contract-o-streams-cases-b.mts";
import { gateway, handles, upstreamServer } from "./contract-o-streams-env.mts";
import { cases } from "./contract-o-streams-helpers.mts";
import { setTimeout as sleep } from "node:timers/promises";

// ---- runner ----------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const CASE_FILTER = process.env.O_CASES;
let failures = 0;
for (const testCase of cases.filter((entry) => !CASE_FILTER || entry.name.includes(CASE_FILTER))) {
  try {
    await testCase.run();
    console.log(`ok ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${testCase.name}`);
    console.log(error instanceof Error ? (error.stack ?? error.message) : error);
  }
}

// Every Go stream must have been served locally: a proxied stream would show up in the upstream
// bridge instead, and a shadowed one would not answer at all.
gateway.log += "";
await sleep(500);
const served = gateway.log
  .split("\n")
  .filter((line) => line.includes('"served_by":"go"'))
  .filter((line) => /threads\.(helper)?[sS]ubscribe|notifications\.subscribe(Calls)?/.test(line));
console.log(`go-served stream completions: ${served.length}`);

console.log(failures === 0 ? `\n${cases.length} cases passed` : `\n${failures} case(s) failed`);
gateway.process?.kill("SIGKILL");
await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
await handles.close?.();
process.exit(failures === 0 ? 0 : 1);
