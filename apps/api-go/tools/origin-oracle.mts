import { readFileSync } from "node:fs";
import { MessageBlock } from "../../../packages/contracts/src/threads/message-blocks.js";

// Regenerates the expected column of the reviewer origin table with the real
// MessageBlock schema. Run from the repo root:
//
//   node_modules/.bin/tsx apps/api-go/tools/origin-oracle.mts > /tmp/origins.json
//
// The input file is kept in the repository; this script removes duplicate
// (kind, origin) rows and recomputes `valid` from zod, so the fixture can be
// audited by diffing its output against the committed table.

interface OriginCase {
  id: string;
  kind: "credential" | "otp";
  origin: string;
  valid?: boolean;
}

const path = process.argv[2] ?? "apps/api-go/internal/messageblocks/testdata/reviewer-origins.json";
const input = JSON.parse(readFileSync(path, "utf8")) as OriginCase[];
const seen = new Set<string>();
const out: OriginCase[] = [];
for (const tc of input) {
  const key = `${tc.kind}\u0000${tc.origin}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const block: Record<string, unknown> = { kind: "ask", text: "x" };
  if (tc.kind === "credential") {
    block.credential = { name: "k", origin: tc.origin, auth: { type: "bearer" } };
  } else {
    block.oneTimeCode = { origin: tc.origin };
  }
  out.push({
    id: tc.id,
    kind: tc.kind,
    origin: tc.origin,
    valid: MessageBlock.array().safeParse([block]).success,
  });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
