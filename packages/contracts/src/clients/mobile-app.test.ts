import { describe, expect, it } from "vitest";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "./client-build.js";
import {
  MOBILE_APP_ANDROID_DOWNLOAD_PATH,
  MobileAppLinksSchema,
  mobileAppUrl,
  parseMobileAppLinks,
  preferredMobileAppUrl,
} from "./mobile-app.js";

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
    MOBILE_APP_ANDROID_DOWNLOAD_PATH,
  ])("rejects %s", (value) => {
    expect(() => parseMobileAppLinks({ MOBILE_APP_ANDROID_URL: value })).toThrow(
      "MOBILE_APP_ANDROID_URL",
    );
  });
});

describe("MobileAppLinksSchema", () => {
  it("accepts the deployment's own download path beside external links", () => {
    expect(
      MobileAppLinksSchema.parse({
        android: MOBILE_APP_ANDROID_DOWNLOAD_PATH,
        ios: "https://example.test/app",
      }),
    ).toEqual({ android: MOBILE_APP_ANDROID_DOWNLOAD_PATH, ios: "https://example.test/app" });
  });

  it.each(["//evil.test/app", "api/account/mobile-app/android", "javascript:alert(1)"])(
    "rejects %s",
    (value) => {
      expect(MobileAppLinksSchema.safeParse({ android: value }).success).toBe(false);
    },
  );
});

describe("mobileAppUrl", () => {
  it("prefers the deployment's own build", () => {
    expect(mobileAppUrl({ android: "https://example.test/rakazo.apk" }, "android")).toBe(
      "https://example.test/rakazo.apk",
    );
  });

  it("keeps the same-origin download path the server answers", () => {
    expect(mobileAppUrl({ android: MOBILE_APP_ANDROID_DOWNLOAD_PATH }, "android")).toBe(
      MOBILE_APP_ANDROID_DOWNLOAD_PATH,
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

describe("preferredMobileAppUrl", () => {
  const apk = "https://example.test/rakazo.apk";
  const iosBuild = "https://example.test/rakazo.ipa";
  const desktop =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const macDesktop =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const android =
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

  it("sends a desktop to the deployment's own Android build", () => {
    expect(preferredMobileAppUrl({ android: apk }, desktop)).toBe(apk);
  });

  it("sends a desktop to an iOS build when that is all the deployment publishes", () => {
    expect(preferredMobileAppUrl({ ios: iosBuild }, desktop)).toBe(iosBuild);
  });

  it("keeps the App Store page for a desktop when the deployment publishes nothing", () => {
    expect(preferredMobileAppUrl(undefined, desktop)).toBe(IOS_APP_STORE_URL);
    expect(preferredMobileAppUrl({}, desktop)).toBe(IOS_APP_STORE_URL);
  });

  it("sends an iPhone to the iOS build", () => {
    expect(preferredMobileAppUrl({ android: apk, ios: iosBuild }, iphone)).toBe(iosBuild);
  });

  it("sends an iPad in desktop mode to the iOS build", () => {
    expect(preferredMobileAppUrl({ android: apk, ios: iosBuild }, macDesktop, 5)).toBe(iosBuild);
    // A real Mac reports no touch points, so it gets what the deployment publishes.
    expect(preferredMobileAppUrl({ android: apk, ios: iosBuild }, macDesktop)).toBe(apk);
  });

  it("sends an Android device to the Android build", () => {
    expect(preferredMobileAppUrl({ android: apk, ios: iosBuild }, android)).toBe(apk);
  });
});
