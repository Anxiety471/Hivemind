import { describe, expect, it } from "vitest";
import { shareSessionCookies, withHostOnlyCookiesExpired } from "./session-cookie-domain.js";

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

describe("shareSessionCookies", () => {
  it("re-issues the session cookies for the domain after expiring the host-only ones", () => {
    expect(
      shareSessionCookies(
        "theme=dark; __Secure-better-auth.session_token=abc.sig; other=1",
        "bocchi.trade",
        600,
      ),
    ).toEqual([
      "__Secure-better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure",
      "__Secure-better-auth.session_token=abc.sig; Max-Age=600; Domain=bocchi.trade; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("shares nothing when there is no session cookie, and each cookie only once", () => {
    expect(shareSessionCookies("theme=dark", "bocchi.trade", 600)).toEqual([]);
    expect(shareSessionCookies(null, "bocchi.trade", 600)).toEqual([]);
    const twice = "better-auth.session_token=a; better-auth.session_token=b";
    expect(shareSessionCookies(twice, "bocchi.trade", 600)).toHaveLength(2);
  });
});
