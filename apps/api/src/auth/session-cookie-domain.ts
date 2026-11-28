/**
 * Better Auth sets the session cookie for the whole cookie domain once `COOKIE_DOMAIN` is set, so
 * a sibling host such as the Drive app can read it. A browser that signed in before keeps a
 * host-only cookie of the same name, and sends both with every request; the older one can win.
 * Each cookie the auth routes set for the domain therefore comes with an expiry for the
 * host-only one, which a domain cookie never replaces.
 */
export function withHostOnlyCookiesExpired(response: Response, cookieDomain: string | undefined) {
  if (!cookieDomain) return response;
  const expired: string[] = [];
  for (const cookie of response.headers.getSetCookie()) {
    if (!/;\s*domain=/i.test(cookie)) continue;
    const name = cookie.slice(0, cookie.indexOf("="));
    const secure = /;\s*secure/i.test(cookie) ? "; Secure" : "";
    expired.push(`${name}=; Path=/; Max-Age=0; HttpOnly${secure}`);
  }
  if (expired.length === 0) return response;
  const headers = new Headers(response.headers);
  const all = [...expired, ...response.headers.getSetCookie()];
  headers.delete("set-cookie");
  for (const cookie of all) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const SESSION_COOKIE = /^(__Secure-)?better-auth\.session_(token|data)$/;

/**
 * `Set-Cookie` lines that move the caller's current session cookies to the whole cookie domain,
 * each after an expiry of its host-only copy. A browser that signed in before COOKIE_DOMAIN was
 * set holds host-only cookies the Drive host never receives; this hands the same session over
 * without a second sign-in.
 */
export function shareSessionCookies(
  cookieHeader: string | null,
  cookieDomain: string,
  maxAgeSeconds: number,
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!SESSION_COOKIE.test(name) || seen.has(name) || value === "") continue;
    seen.add(name);
    const secure = name.startsWith("__Secure-") ? "; Secure" : "";
    lines.push(`${name}=; Path=/; Max-Age=0; HttpOnly${secure}`);
    lines.push(
      `${name}=${value}; Max-Age=${maxAgeSeconds}; Domain=${cookieDomain}; Path=/; HttpOnly${secure}; SameSite=Lax`,
    );
  }
  return lines;
}
