/**
 * Regenerates internal/procedures/shared/testdata/join-*.json: what Node's WHATWG URL makes of
 * `new URL("/join/" + id, origin).toString()`, the reference JoinURL (shared/url.go) is tested against.
 * Run from the repo root of a checkout with node_modules: node_modules/.bin/tsx apps/api-go/tools/url-corpus.mts
 * (from apps/api-go, so the relative output paths resolve).
 */
import { writeFileSync } from "node:fs";
const origin = "https://bots.bocchi.trade";
const ids: string[] = [];
for (let c = 0; c < 0x80; c++) { const ch = String.fromCharCode(c); ids.push(`a${ch}b`, ch, `${ch}a`, `a${ch}`); }
for (const ch of ["é", "😀", "\u00a0", "\u2028", "\ufffd", "日本", "\u0085"]) ids.push(`a${ch}b`, ch);
ids.push("?a'b", "?a b", "?a\"b", "?a<b", "?a>b", "?a`b", "?a{b", "?a^b", "?é", "?\u0001", "#a`b", "#a b", "#a\"b", "#a<b", "#a>b", "#a'b", "#é", "#\u0001", "a?b?c", "a#b#c", "a?b#c?d", "x?y\\z", "x#y\\z", "?%", "#%", ".", "..", "...", "%2e", "%2E", "%2e%2e", ".%2e", "%2e.", "a/..", "a/../b", "a/./b", "a\\b", "a\\..\\b", "?x", "#y", "a?b#c", "a%", "%zz", "%41", "a b", " a", "a ", "\t", "a\tb", "a\nb", "x/", "/x", "//x", "a//b", "..%2f", "a;b", "a=b", "a@b", "a:b", "uuid-1234-ABCD", "123e4567-e89b-12d3-a456-426614174000");
const rows = ids.map((id) => { let href: string | null; try { href = new URL(`/join/${id}`, origin).toString(); } catch { href = null; } return { id, href }; });
writeFileSync("internal/procedures/shared/testdata/join-urls.json", JSON.stringify(rows));
// other origins
const origins = ["https://bots.bocchi.trade", "http://127.0.0.1:5173", "https://Example.COM:443", "http://example.com:80", "https://example.com:8443", "http://[::1]:5173", "https://bücher.example", "https://user:pw@example.com", "https://example.com/app", "https://xn--bcher-kva.example"];
const orows = origins.map((o) => ({ origin: o, href: new URL("/join/abc", o).toString() }));
writeFileSync("internal/procedures/shared/testdata/join-origins.json", JSON.stringify(orows));
