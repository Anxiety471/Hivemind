import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../../packages/testkit/src/index.js";
import { createApp } from "../app.js";

const androidUrl = "https://downloads.example.test/rakazo.apk";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("deployment mobile app links", () => {
  it("serves MOBILE_APP_ANDROID_URL through me and bootstrap", async () => {
    process.env.MOBILE_APP_ANDROID_URL = androidUrl;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-mobile-app-test-"));
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
      expect(await me.json()).toMatchObject({ json: { mobileApp: { android: androidUrl } } });

      // The sidebar reads the account menu's link from the bootstrap's `me`, not from `me`.
      const bootstrap = await call("bootstrap");
      expect(bootstrap.status).toBe(200);
      expect(await bootstrap.json()).toMatchObject({
        json: { me: { mobileApp: { android: androidUrl } } },
      });
    } finally {
      await handles.stop();
      delete process.env.MOBILE_APP_ANDROID_URL;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
