import { readFileSync } from "node:fs";

// Regenerates the WHATWG URL component fixture with Node's real `new URL`.
// Run from the repo root:
//
//   node_modules/.bin/tsx apps/api-go/tools/whatwg-url-oracle.mts > /tmp/corpus.json
//
// The input may be the committed fixture (expected fields are ignored and
// recomputed) or an input-only JSON array of `{id,input,base?}`. The output
// keeps only the fields the Go parity test reads.

interface UrlCase {
  id: string;
  input: string;
  base?: string;
  throws?: boolean;
  href?: string;
  origin?: string;
  host?: string;
  hostname?: string;
  port?: string;
  // Every component messageblocks.validOrigin reads: the path/query/fragment
  // and userinfo decide the accept/reject the same way the zod refine does.
  protocol?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  username?: string;
  password?: string;
}

const path = process.argv[2] ?? "apps/api-go/internal/whatwgurl/testdata/whatwg-url-corpus.json";
const input = JSON.parse(readFileSync(path, "utf8")) as UrlCase[];
const out: UrlCase[] = [];
for (const tc of input) {
  const item: UrlCase = { id: tc.id, input: tc.input };
  if (tc.base !== undefined) item.base = tc.base;
  try {
    const url = tc.base === undefined ? new URL(tc.input) : new URL(tc.input, tc.base);
    item.href = url.href;
    item.origin = url.origin;
    item.host = url.host;
    item.hostname = url.hostname;
    item.port = url.port;
    item.protocol = url.protocol;
    item.pathname = url.pathname;
    item.search = url.search;
    item.hash = url.hash;
    item.username = url.username;
    item.password = url.password;
  } catch {
    item.throws = true;
  }
  out.push(item);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
