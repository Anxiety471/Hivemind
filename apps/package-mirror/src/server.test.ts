import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MirrorConfig } from "./config.js";
import type { FakeUpstream, RunningMirror } from "./test-support.js";
import { fakeUpstream, startMirror } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];

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

function packument(name: string, version: string, bytes: Buffer, integrity?: string): string {
  const filename = `${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
  return JSON.stringify({
    name,
    versions: {
      [version]: {
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${filename}`,
          integrity: integrity ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          shasum: createHash("sha1").update(bytes).digest("hex"),
        },
      },
    },
  });
}

describe("npm registry", () => {
  it("rewrites tarball URLs, caches packuments, and forwards no client headers", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", Buffer.from("tarball")),
    });

    const response = await fetch(`${server.url}/npm/left-pad`, {
      headers: { cookie: "session=secret", authorization: "Bearer token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cache")).toBe("miss");
    const body = (await response.json()) as {
      versions: Record<string, { dist: { tarball: string } }>;
    };
    expect(body.versions["1.0.0"]?.dist.tarball).toBe(
      "http://mirror.test/npm/left-pad/-/left-pad-1.0.0.tgz",
    );

    const cached = await fetch(`${server.url}/npm/left-pad`);
    expect(cached.headers.get("x-cache")).toBe("hit");
    expect(upstream.requests.filter((request) => request.url === "/left-pad")).toHaveLength(1);
    const upstreamRequest = upstream.requests.find((request) => request.url === "/left-pad");
    expect(upstreamRequest?.headers.cookie).toBeUndefined();
    expect(upstreamRequest?.headers.authorization).toBeUndefined();
  });

  it("fetches a packument once for concurrent requests", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", Buffer.from("bytes")),
      delayMs: 50,
    });
    const responses = await Promise.all([
      fetch(`${server.url}/npm/left-pad`),
      fetch(`${server.url}/npm/left-pad`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(upstream.requests.filter((request) => request.url === "/left-pad")).toHaveLength(1);
  });

  it("accepts npm's percent-encoded scoped package name", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/@scope/name", {
      contentType: "application/json",
      body: packument("@scope/name", "1.0.0", Buffer.from("scoped")),
    });

    const response = await fetch(`${server.url}/npm/@scope%2fname`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      versions: Record<string, { dist: { tarball: string } }>;
    };
    expect(body.versions["1.0.0"]?.dist.tarball).toBe(
      "http://mirror.test/npm/@scope/name/-/name-1.0.0.tgz",
    );
  });

  it("serves a verified tarball from cache", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("verified tarball bytes");
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", bytes),
    });
    upstream.respond("/left-pad/-/left-pad-1.0.0.tgz", { body: bytes });

    const first = await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
    expect(first.headers.get("x-cache")).toBe("miss");

    const second = await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(
      upstream.requests.filter((request) => request.url === "/left-pad/-/left-pad-1.0.0.tgz"),
    ).toHaveLength(1);
  });

  it("serves a cached tarball even when its packument is unavailable", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("verified tarball bytes");
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", bytes),
    });
    upstream.respond("/left-pad/-/left-pad-1.0.0.tgz", { body: bytes });
    expect((await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`)).status).toBe(200);
    upstream.respond("/left-pad", { status: 500 });
    upstream.respond("/left-pad/-/left-pad-1.0.0.tgz", { status: 500 });
    const cached = await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`);
    expect(cached.status).toBe(200);
    expect(cached.headers.get("x-cache")).toBe("hit");
  });

  it("rejects a tarball whose bytes do not match the packument and caches nothing", async () => {
    const { upstream, mirror: server } = await mirror();
    const published = Buffer.from("published bytes");
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", published),
    });
    upstream.respond("/left-pad/-/left-pad-1.0.0.tgz", { body: Buffer.from("tampered bytes") });

    const first = await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`);
    expect(first.status).toBe(502);
    expect(await first.text()).toContain("integrity");
    const second = await fetch(`${server.url}/npm/left-pad/-/left-pad-1.0.0.tgz`);
    expect(second.status).toBe(502);
    expect(
      upstream.requests.filter((request) => request.url === "/left-pad/-/left-pad-1.0.0.tgz"),
    ).toHaveLength(2);
  });

  it("serves a stale packument when the upstream fails", async () => {
    const { upstream, mirror: server } = await mirror({ indexTtlMs: 0 });
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", Buffer.from("bytes")),
    });
    expect((await fetch(`${server.url}/npm/left-pad`)).status).toBe(200);
    upstream.respond("/left-pad", { status: 500, body: "broken" });

    const stale = await fetch(`${server.url}/npm/left-pad`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("stale");
    const body = (await stale.json()) as { versions: Record<string, unknown> };
    expect(Object.keys(body.versions)).toEqual(["1.0.0"]);
  });
});

describe("request handling", () => {
  it("refuses methods other than GET and HEAD", async () => {
    const { upstream, mirror: server } = await mirror();
    const response = await fetch(`${server.url}/npm/left-pad`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(upstream.requests).toHaveLength(0);
  });

  it("answers HEAD with the headers of a GET and no body", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/left-pad", {
      contentType: "application/json",
      body: packument("left-pad", "1.0.0", Buffer.from("bytes")),
    });
    const response = await fetch(`${server.url}/npm/left-pad`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.text()).toBe("");
  });

  it("refuses paths that could leave the mirror", async () => {
    const { upstream, mirror: server } = await mirror();
    for (const path of [
      "/npm/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/npm/..%2f..%2fetc",
      "/npm/%00",
      `/pypi/files/${"a".repeat(64)}/..%2f..%2fetc`,
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status, path).toBe(400);
    }
    // The URL parser folds plain dot segments before the request, so this one never routes.
    expect((await fetch(`${server.url}/go/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses an upstream redirect to a host outside the allowlist", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/left-pad", {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    });
    const response = await fetch(`${server.url}/npm/left-pad`);
    expect(response.status).toBe(502);
  });

  it("reports health and cache usage", async () => {
    const { mirror: server } = await mirror();
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });
});

describe("PyPI simple index", () => {
  it("rewrites JSON file URLs and verifies downloaded files", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("demo sdist");
    const hash = sha256(bytes);
    upstream.respond("/simple/demo/", {
      contentType: "application/vnd.pypi.simple.v1+json",
      body: JSON.stringify({
        files: [
          {
            filename: "demo-1.0.tar.gz",
            url: `${upstream.url}/packages/aa/demo-1.0.tar.gz#sha256=${hash}`,
            hashes: { sha256: hash },
            "core-metadata": { sha256: hash },
            "data-dist-info-metadata": { sha256: hash },
          },
        ],
      }),
    });
    upstream.respond("/packages/aa/demo-1.0.tar.gz", { body: bytes });

    const index = await fetch(`${server.url}/pypi/simple/demo/`);
    expect(index.status).toBe(200);
    const data = (await index.json()) as { files: { url: string }[] };
    expect(data.files[0]?.url).toBe(`http://mirror.test/pypi/files/${hash}/demo-1.0.tar.gz`);
    // No sidecar is advertised, since the mirror does not serve it.
    expect(Object.keys(data.files[0] ?? {}).filter((key) => key.includes("metadata"))).toEqual([]);

    const file = await fetch(`${server.url}/pypi/files/${hash}/demo-1.0.tar.gz`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    const cached = await fetch(`${server.url}/pypi/files/${hash}/demo-1.0.tar.gz`);
    expect(cached.headers.get("x-cache")).toBe("hit");
    expect(
      upstream.requests.filter((request) => request.url === "/packages/aa/demo-1.0.tar.gz"),
    ).toHaveLength(1);
  });

  it("rejects a file whose bytes do not match the published sha256", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("real bytes");
    const published = Buffer.from("other bytes");
    const hash = sha256(published);
    upstream.respond("/simple/demo/", {
      contentType: "application/vnd.pypi.simple.v1+json",
      body: JSON.stringify({
        files: [
          {
            filename: "demo-1.0.tar.gz",
            url: `${upstream.url}/packages/aa/demo-1.0.tar.gz#sha256=${hash}`,
            hashes: { sha256: hash },
          },
        ],
      }),
    });
    upstream.respond("/packages/aa/demo-1.0.tar.gz", { body: bytes });
    expect((await fetch(`${server.url}/pypi/simple/demo/`)).status).toBe(200);

    const response = await fetch(`${server.url}/pypi/files/${hash}/demo-1.0.tar.gz`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("sha256");
  });

  it("rewrites HTML simple indexes", async () => {
    const { upstream, mirror: server } = await mirror();
    const bytes = Buffer.from("html sdist");
    const hash = sha256(bytes);
    upstream.respond("/simple/demo/", {
      contentType: "text/html",
      body: `<html><body><a href="${upstream.url}/packages/bb/demo-2.0.tar.gz#sha256=${hash}" data-core-metadata="sha256=${hash}">demo-2.0.tar.gz</a></body></html>`,
    });

    const response = await fetch(`${server.url}/pypi/simple/demo/`);
    const html = await response.text();
    expect(html).toContain(`http://mirror.test/pypi/files/${hash}/demo-2.0.tar.gz`);
    expect(html).not.toContain("metadata");
  });
});

describe("Go module proxy", () => {
  it("caches version lists briefly and version files forever", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond("/example.com/mod/@v/list", {
      contentType: "text/plain",
      body: "v1.0.0\nv1.1.0\n",
    });
    upstream.respond("/example.com/mod/@latest", {
      contentType: "application/json",
      body: JSON.stringify({ Version: "v1.1.0", Time: "2024-01-01T00:00:00Z" }),
    });
    upstream.respond("/example.com/mod/@v/v1.0.0.zip", { body: Buffer.from("zip bytes") });

    const list = await fetch(`${server.url}/go/example.com/mod/@v/list`);
    expect(list.status).toBe(200);
    expect(await list.text()).toBe("v1.0.0\nv1.1.0\n");
    expect((await fetch(`${server.url}/go/example.com/mod/@v/list`)).headers.get("x-cache")).toBe(
      "hit",
    );

    const latest = await fetch(`${server.url}/go/example.com/mod/@latest`);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ Version: "v1.1.0" });
    expect(upstream.requests.some((request) => request.url === "/example.com/mod/@latest")).toBe(
      true,
    );

    const zip = await fetch(`${server.url}/go/example.com/mod/@v/v1.0.0.zip`);
    expect(Buffer.from(await zip.arrayBuffer())).toEqual(Buffer.from("zip bytes"));
    upstream.respond("/example.com/mod/@v/v1.0.0.zip", { status: 500 });
    const cachedZip = await fetch(`${server.url}/go/example.com/mod/@v/v1.0.0.zip`);
    expect(cachedZip.status).toBe(200);
    expect(cachedZip.headers.get("x-cache")).toBe("hit");
  });
});
