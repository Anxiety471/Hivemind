import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOBILE_APP_ANDROID_DOWNLOAD_PATH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../../packages/testkit/src/index.js";
import { createApp } from "../app.js";

const apk = Buffer.from("PK\u0003\u0004 signed android build");

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("deployment mobile app download", () => {
  it("advertises and serves the stored APK only to a signed-in account", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-mobile-app-test-"));
    const apkPath = join(dataDir, "app.apk");
    await writeFile(apkPath, apk);
    process.env.MOBILE_APP_ANDROID_FILE = apkPath;
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: "http://127.0.0.1:5173",
      authUrl: "http://127.0.0.1:5173",
    });
    try {
      const url = `http://127.0.0.1:5173${MOBILE_APP_ANDROID_DOWNLOAD_PATH}`;
      expect((await handles.app.request(MOBILE_APP_ANDROID_DOWNLOAD_PATH)).status).toBe(401);

      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `mobile-app-${Date.now()}@rakazo.test`,
          password: "test-password-123",
          name: "Mobile app tester",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = (procedure: string, json: unknown = {}) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({ json }),
        });

      const me = await call("me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        json: { mobileApp: { android: MOBILE_APP_ANDROID_DOWNLOAD_PATH } },
      });

      // The sidebar reads the account menu's link from the bootstrap's `me`, not from `me`.
      const bootstrap = await call("bootstrap");
      expect(bootstrap.status).toBe(200);
      expect(await bootstrap.json()).toMatchObject({
        json: { me: { mobileApp: { android: MOBILE_APP_ANDROID_DOWNLOAD_PATH } } },
      });

      const download = await handles.app.request(url, { headers: { cookie } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(download.headers.get("content-disposition")).toBe('attachment; filename="app.apk"');
      expect(Buffer.from(await download.arrayBuffer())).toEqual(apk);
    } finally {
      await handles.stop();
      delete process.env.MOBILE_APP_ANDROID_FILE;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
