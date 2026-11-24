import { afterEach, describe, expect, it } from "vitest";
import type { MirrorConfig } from "./config.js";
import type { FakeUpstream, RunningMirror } from "./test-support.js";
import { fakeUpstream, startMirror } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
const PACKAGES = "/packages.json";
const METADATA = "/p2/monolog/monolog.json";
const METADATA_DEV = "/p2/monolog/monolog~dev.json";

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

function packagesJson(): string {
  return JSON.stringify({
    packages: [],
    "metadata-url": "https://repo.packagist.org/p2/%package%.json",
    "providers-url": "/p/%package%$%hash%.json",
    "providers-api": "https://packagist.org/providers/%package%.json",
    "metadata-changes-url": "https://packagist.org/metadata/changes.json",
    "available-packages": ["monolog/monolog"],
    "notify-batch": "https://packagist.org/downloads/",
    search: "https://packagist.org/search.json?q=%query%",
    list: "https://packagist.org/packages/list.json",
    warning: "metadata is cached by the mirror",
  });
}

describe("Composer repository", () => {
  it("rewrites packages.json into a minimal Composer 2 root", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond(PACKAGES, { contentType: "application/json", body: packagesJson() });

    const response = await fetch(`${server.url}/composer/packages.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cache")).toBe("miss");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["metadata-url"]).toBe("/composer/p2/%package%.json");
    expect(body.packages).toEqual([]);
    expect(body["notify-batch"]).toBe("https://packagist.org/downloads/");
    expect(body.search).toBe("https://packagist.org/search.json?q=%query%");
    expect(body.list).toBe("https://packagist.org/packages/list.json");
    expect(body.warning).toBe("metadata is cached by the mirror");
    for (const dropped of [
      "providers-url",
      "providers-api",
      "metadata-changes-url",
      "available-packages",
    ])
      expect(body, dropped).not.toHaveProperty(dropped);

    const cached = await fetch(`${server.url}/composer/packages.json`);
    expect(cached.headers.get("x-cache")).toBe("hit");
    expect(upstream.requests.filter((request) => request.url === PACKAGES)).toHaveLength(1);
  });

  it("drops relative optional endpoints instead of pointing them at the mirror", async () => {
    const { upstream, mirror: server } = await mirror();
    upstream.respond(PACKAGES, {
      contentType: "application/json",
      body: JSON.stringify({
        packages: [],
        "notify-batch": "/downloads/",
        search: "/search.json",
        list: "/list.json",
      }),
    });
    const body = (await (await fetch(`${server.url}/composer/packages.json`)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ packages: [], "metadata-url": "/composer/p2/%package%.json" });
  });

  it("proxies p2 metadata without touching dist URLs", async () => {
    const { upstream, mirror: server } = await mirror();
    const metadata = JSON.stringify({
      packages: {
        "monolog/monolog": [
          {
            version: "3.0.0",
            dist: {
              type: "zip",
              url: "https://api.github.com/repos/Seldaek/monolog/zipball/abc123",
            },
          },
        ],
      },
    });
    upstream.respond(METADATA, { contentType: "application/json", body: metadata });
    upstream.respond(METADATA_DEV, { contentType: "application/json", body: metadata });

    const response = await fetch(`${server.url}/composer/p2/monolog/monolog.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      packages: Record<string, { dist: { url: string } }[]>;
    };
    expect(body.packages["monolog/monolog"]?.[0]?.dist.url).toBe(
      "https://api.github.com/repos/Seldaek/monolog/zipball/abc123",
    );
    expect(
      (await fetch(`${server.url}/composer/p2/monolog/monolog.json`)).headers.get("x-cache"),
    ).toBe("hit");

    const dev = await fetch(`${server.url}/composer/p2/monolog/monolog~dev.json`);
    expect(dev.status).toBe(200);
    expect(await dev.json()).toEqual(JSON.parse(metadata));
    expect(upstream.requests.filter((request) => request.url === METADATA)).toHaveLength(1);
  });

  it("serves a stale packages.json when the upstream fails", async () => {
    const { upstream, mirror: server } = await mirror({ indexTtlMs: 0 });
    upstream.respond(PACKAGES, { contentType: "application/json", body: packagesJson() });
    expect((await fetch(`${server.url}/composer/packages.json`)).status).toBe(200);
    upstream.respond(PACKAGES, { status: 500 });

    const stale = await fetch(`${server.url}/composer/packages.json`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("stale");
  });

  it("refuses methods other than GET and HEAD", async () => {
    const { upstream, mirror: server } = await mirror();
    const response = await fetch(`${server.url}/composer/packages.json`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects paths outside the p2 metadata layout", async () => {
    const { upstream, mirror: server } = await mirror();
    for (const path of [
      "/composer/p2/monolog/monolog",
      "/composer/p2/monolog/monolog.json/extra",
      "/composer/p2/Monolog/monolog.json",
      "/composer/p2/monolog/%2e%2e.json",
      "/composer/p2/monolog/%2e%2e",
      "/composer/p2/monolog/~dev.json",
      "/composer/unknown.json",
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect([400, 404], path).toContain(response.status);
    }
    expect(upstream.requests).toHaveLength(0);
  });
});
