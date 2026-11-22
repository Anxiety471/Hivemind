import { describe, expect, it } from "vitest";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "./client-build.js";
import { mobileAppUrl, parseMobileAppLinks } from "./mobile-app.js";

describe("parseMobileAppLinks", () => {
  it("publishes nothing of its own when unset", () => {
    expect(parseMobileAppLinks({})).toEqual({});
    expect(parseMobileAppLinks({ MOBILE_APP_ANDROID_URL: " ", MOBILE_APP_IOS_URL: "" })).toEqual(
      {},
    );
  });

  it("keeps each platform's https link", () => {
    expect(
      parseMobileAppLinks({
        MOBILE_APP_ANDROID_URL: " https://example.test/rakazo.apk ",
        MOBILE_APP_IOS_URL: "https://example.test/app",
      }),
    ).toEqual({
      android: "https://example.test/rakazo.apk",
      ios: "https://example.test/app",
    });
  });

  it.each([
    "http://example.test/app",
    "example.test/app",
    "ftp://example.test/app",
    "https://user:secret@example.test/app",
    "javascript:alert(1)",
  ])("rejects %s", (value) => {
    expect(() => parseMobileAppLinks({ MOBILE_APP_ANDROID_URL: value })).toThrow(
      "MOBILE_APP_ANDROID_URL",
    );
  });
});

describe("mobileAppUrl", () => {
  it("prefers the deployment's own build", () => {
    expect(mobileAppUrl({ android: "https://example.test/rakazo.apk" }, "android")).toBe(
      "https://example.test/rakazo.apk",
    );
  });

  it("falls back to the app's store page for a platform without one", () => {
    expect(mobileAppUrl(undefined, "android")).toBe(ANDROID_APP_STORE_URL);
    expect(mobileAppUrl({}, "ios")).toBe(IOS_APP_STORE_URL);
    expect(mobileAppUrl({ android: "https://example.test/rakazo.apk" }, "ios")).toBe(
      IOS_APP_STORE_URL,
    );
  });
});
