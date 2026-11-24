import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MirrorConfig } from "./config.js";
import type { FakeUpstream, RunningMirror } from "./test-support.js";
import { fakeUpstream, startMirror } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
const INDEX_PATH = "/se/rd/serde";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function mirror(
  overrides: Partial<MirrorConfig> = {},
): Promise<{ upstream: FakeUpstream; mirror: RunningMirror }> {
  const upstream = await fakeUpstream();
  const running = await startMirror(upstream.url, overrides);
  cleanups.push(running.close, upstream.close);
  return { upstream, mirror: running };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexLine(version: string, cksum: string): string {
  return `${JSON.stringify({ name: "serde", vers: version, cksum, yanked: false })}\n`;
}

describe("cargo sparse registry", () => {
  it("serves a read-only sparse index config with the mirror's download base", async () => {
    const { mirror: server } = await mirror();
    const response = await fetch(`${server.url}/crates/index/config.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dl: "http://mirror.test/crates/dl/{crate}/{version}",
    });
  });

  it("accepts each of cargo's four index layouts", async () => {
    const { upstream, mirror: server } = await mirror();
    for (const path of ["1/a", "2/ab", "3/a/abc", "ab/cd/abcd"])
      upstream.respond(`/${path}`, { contentType: "text/plain", body: "{}\n" });
    for (const path of ["1/a", "2/ab", "3/a/abc", "ab/cd/abcd"]) {
      const response = await fetch(`${server.url}/crates/index/${path}`);
      expect(response.status, path).toBe(200);
    }
  });

  it("proxies the sparse index and caches it", async () => {
    const { upstream, mirror: server } = await mirror();
    const body = indexLine("1.0.0", "a".repeat(64));
    upstream.respond(INDEX_PATH, { contentType: "text/plain", body });

    const first = await fetch(`${server.url}/crates/index/se/rd/serde`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(body);
    expect(first.headers.get("x-cache")).toBe("miss");
    expect(first.headers.get("content-type")).toContain("text/plain");

    const second = await fetch(`${server.url}/crates/index/se/rd/serde`);
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(upstream.requests.filter((request) => request.url === INDEX_PATH)).toHaveLength(1);
  });

  it("serves a crate verified against its index cksum and caches it", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("crate bytes");
    upstream.respond(INDEX_PATH, {
      contentType: "text/plain",
      body: indexLine("1.0.0", sha256(bytes)),
    });
    upstream.respond("/serde/serde-1.0.0.crate", { body: bytes });

    const first = await fetch(`${server.url}/crates/dl/serde/1.0.0`);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
    expect(first.headers.get("x-cache")).toBe("miss");

    const second = await fetch(`${server.url}/crates/dl/serde/1.0.0`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(
      upstream.requests.filter((request) => request.url === "/serde/serde-1.0.0.crate"),
    ).toHaveLength(1);
  });

  it("serves a cached crate when the index upstream is down", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("crate bytes");
    upstream.respond(INDEX_PATH, {
      contentType: "text/plain",
      body: indexLine("1.0.0", sha256(bytes)),
    });
    upstream.respond("/serde/serde-1.0.0.crate", { body: bytes });
    expect((await fetch(`${server.url}/crates/dl/serde/1.0.0`)).status).toBe(200);
    upstream.respond(INDEX_PATH, { status: 500 });
    upstream.respond("/serde/serde-1.0.0.crate", { status: 500 });

    const cached = await fetch(`${server.url}/crates/dl/serde/1.0.0`);
    expect(cached.status).toBe(200);
    expect(cached.headers.get("x-cache")).toBe("hit");
  });

  it("rejects a crate whose bytes do not match the cksum and caches nothing", async () => {
    const { upstream, mirror: server } = await mirror();
    const published = Buffer.from("published crate");
    upstream.respond(INDEX_PATH, {
      contentType: "text/plain",
      body: indexLine("1.0.0", sha256(published)),
    });
    upstream.respond("/serde/serde-1.0.0.crate", { body: Buffer.from("tampered crate") });

    const first = await fetch(`${server.url}/crates/dl/serde/1.0.0`);
    expect(first.status).toBe(502);
    expect(await first.text()).toContain("cksum");
    const second = await fetch(`${server.url}/crates/dl/serde/1.0.0`);
    expect(second.status).toBe(502);
    expect(
      upstream.requests.filter((request) => request.url === "/serde/serde-1.0.0.crate"),
    ).toHaveLength(2);
  });

  it("rejects paths that do not follow cargo's index layout or name rules", async () => {
    const { upstream, mirror: server } = await mirror();
    for (const path of [
      "/crates/index/1/ab",
      "/crates/index/2/abc",
      "/crates/index/3/b/abc",
      "/crates/index/ab/cd/xyz",
      "/crates/index/se/rd/serde/extra",
      "/crates/index/se/rd/SERDE",
      "/crates/dl/serde/1.0.0/extra",
      "/crates/dl/Serde/1.0.0",
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status, path).toBe(400);
    }
    // The URL parser collapses percent-encoded dot segments before routing; either way the
    // request never reaches an upstream.
    for (const path of [
      "/crates/index/se/rd/%2e%2e",
      "/crates/dl/%2e%2e/1.0.0",
      "/crates/dl/serde/%2e%2e",
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect([400, 404], path).toContain(response.status);
    }
    expect(upstream.requests).toHaveLength(0);
  });
});
