import * as z from "zod";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "./client-build.js";

/** Mobile platforms a deployment can publish a build for. */
const MOBILE_APP_PLATFORMS = ["android", "ios"] as const;
export type MobileAppPlatform = (typeof MOBILE_APP_PLATFORMS)[number];

/** The app's own store pages, offered for a platform a deployment does not publish itself. */
const MOBILE_APP_STORE_URLS: Record<MobileAppPlatform, string> = {
  android: ANDROID_APP_STORE_URL,
  ios: IOS_APP_STORE_URL,
};

function isPublicHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const MobileAppUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isPublicHttpsUrl, "Use an https:// URL");

/**
 * Builds this deployment publishes, keyed by platform (MOBILE_APP_ANDROID_URL, MOBILE_APP_IOS_URL).
 * A platform without one offers the app's store page instead; see `mobileAppUrl`.
 */
export const MobileAppLinksSchema = z.object({
  android: MobileAppUrlSchema.optional(),
  ios: MobileAppUrlSchema.optional(),
});
export type MobileAppLinks = z.infer<typeof MobileAppLinksSchema>;

const MOBILE_APP_ENV = { android: "MOBILE_APP_ANDROID_URL", ios: "MOBILE_APP_IOS_URL" } as const;

/** Reads the operator's links; a bad one fails at boot rather than vanishing from the app. */
export function parseMobileAppLinks(source: {
  MOBILE_APP_ANDROID_URL?: string;
  MOBILE_APP_IOS_URL?: string;
}): MobileAppLinks {
  const links: MobileAppLinks = {};
  for (const platform of MOBILE_APP_PLATFORMS) {
    const key = MOBILE_APP_ENV[platform];
    if (!source[key]?.trim()) continue;
    const parsed = MobileAppUrlSchema.safeParse(source[key]);
    if (!parsed.success) throw new Error(`${key} must be an https:// URL`);
    links[platform] = parsed.data;
  }
  return links;
}

/** The URL to offer for a platform: this deployment's own build when it publishes one. */
export function mobileAppUrl(
  links: MobileAppLinks | null | undefined,
  platform: MobileAppPlatform,
): string {
  return links?.[platform] ?? MOBILE_APP_STORE_URLS[platform];
}

/**
 * The mobile platform a browser names, or null for a desktop. iPadOS reports the desktop Mac
 * user agent, so its touch points are what tell an iPad (which wants iOS) from a Mac.
 */
export function deviceMobileAppPlatform(
  userAgent: string,
  maxTouchPoints = 0,
): MobileAppPlatform | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return null;
}

/**
 * The URL to offer a browser: its own platform's build, or for a desktop the build this
 * deployment publishes itself (Android first, since that is the one self-hosting produces).
 * A deployment publishing nothing still offers the App Store page a desktop saw before.
 */
export function preferredMobileAppUrl(
  links: MobileAppLinks | null | undefined,
  userAgent: string,
  maxTouchPoints = 0,
): string {
  const platform =
    deviceMobileAppPlatform(userAgent, maxTouchPoints) ??
    // An Android build wins; otherwise iOS, which also keeps the App Store page when none exists.
    (links?.android ? "android" : "ios");
  return mobileAppUrl(links, platform);
}
