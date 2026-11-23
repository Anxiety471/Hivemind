import { describe, expect, it } from "vitest";
import { withHostOnlyCookiesExpired } from "./session-cookie-domain.js";

function responseWith(...cookies: string[]) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response("{}", { status: 200, headers });
}

describe("withHostOnlyCookiesExpired", () => {
  it("expires the host-only twin of every cookie set for the domain, before the real one", async () => {
    const response = withHostOnlyCookiesExpired(
      responseWith(
        "__Secure-better-auth.session_token=abc; Max-Age=604800; Domain=bocchi.trade; Path=/; HttpOnly; Secure; SameSite=Lax",
      ),
      "bocchi.trade",
    );
    expect(response.headers.getSetCookie()).toEqual([
      "__Secure-better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure",
      "__Secure-better-auth.session_token=abc; Max-Age=604800; Domain=bocchi.trade; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await response.text()).toBe("{}");
  });

  it("leaves cookies without a domain, and every response when no domain is configured", () => {
    const plain = responseWith("theme=dark; Path=/");
    expect(withHostOnlyCookiesExpired(plain, "bocchi.trade")).toBe(plain);
    const domain = responseWith("a=b; Domain=bocchi.trade; Path=/");
    expect(withHostOnlyCookiesExpired(domain, undefined)).toBe(domain);
  });
});
