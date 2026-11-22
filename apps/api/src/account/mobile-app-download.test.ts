import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@rakazo/contracts";
import { MOBILE_APP_ANDROID_DOWNLOAD_PATH } from "@rakazo/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountMobileAppDownloadRoute } from "./mobile-app-download.js";

const actor = { userId: "user-1", spaceId: "space-1" } as unknown as Actor;
const apk = Buffer.from("PK\u0003\u0004 signed android build");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rakazo-mobile-app-route-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function appFor(filePath: string | undefined, signedIn: boolean) {
  const app = new Hono();
  mountMobileAppDownloadRoute(app, {
    sessionActor: async () => (signedIn ? actor : null),
    filePath,
  });
  return app;
}

describe("GET /api/account/mobile-app/android", () => {
  it("refuses a request without a session", async () => {
    const file = join(dir, "app.apk");
    await writeFile(file, apk);
    const response = await appFor(file, false).request(MOBILE_APP_ANDROID_DOWNLOAD_PATH);
    expect(response.status).toBe(401);
  });

  it("streams the stored APK to a signed-in account", async () => {
    const file = join(dir, "app.apk");
    await writeFile(file, apk);
    const response = await appFor(file, true).request(MOBILE_APP_ANDROID_DOWNLOAD_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(response.headers.get("content-length")).toBe(String(apk.length));
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="app.apk"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(apk);

    const head = await appFor(file, true).request(MOBILE_APP_ANDROID_DOWNLOAD_PATH, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(apk.length));
    expect(await head.text()).toBe("");
  });

  it("answers 404 when the configured file is missing or unset", async () => {
    for (const file of [join(dir, "missing.apk"), undefined]) {
      const response = await appFor(file, true).request(MOBILE_APP_ANDROID_DOWNLOAD_PATH);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });
});
