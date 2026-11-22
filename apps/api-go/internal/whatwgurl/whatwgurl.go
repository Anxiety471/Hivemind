// Package whatwgurl reproduces the WHATWG URL API of Node's `URL` class for the
// procedures that parse, normalize or compare web addresses.
//
// The TypeScript API uses `new URL(...)` and reads `.href`, `.origin`,
// `.protocol`, `.hostname`, `.host`, `.pathname`, `.search`, `.hash`,
// `.username`, `.password`, `.port`, `.searchParams`, and assigns `.hostname`,
// `.pathname` and `.hash` (see docs/infra-d-design.md for the site list). Go's
// net/url is not WHATWG: it does not lowercase and punycode hosts through
// UTS 46, rewrite IPv4 shorthands (0x7f.1, 127.1, 2130706433), strip ASCII tab
// and newline, treat `\` as a path separator, drop default ports or serialize
// percent-encoding with the URL spec's sets. This package pins the parser that
// does, and adds the pieces Node exposes that the parser library does not:
// `origin` (including `blob:` unwrapping) and the zod `.url()` acceptance rule.
//
// The parser is a copy of github.com/nationallibraryofnorway/whatwg-url v0.9.1
// (Apache-2.0, parser/LICENSE) under parser/, with Node's IDNA bidi handling:
// see parser/adaidna.go. tools/infra-d-url-proof.mts proves it against Node
// 24.22.3 over the bundled web-platform-tests urltestdata.json and
// setters_tests.json, the IDNA conformance data, and a generated corpus of the
// inputs these procedures see.
package whatwgurl

import (
	"errors"

	wurl "github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl/parser"
)

// URL is one parsed URL record. It mirrors the browser `URL` object; the zero
// value is not usable. Parse and the setters are the only constructors.
type URL struct {
	record *wurl.Url
}

// ErrInvalidURL is returned when the URL parser rejects the input, which is the
// TypeError `new URL(...)` throws in JavaScript. Callers that only branch on
// success can use CanParse.
var ErrInvalidURL = errors.New("whatwgurl: invalid URL")

// Parse is `new URL(input)`: a URL with no base. Leading and trailing C0
// control or space are trimmed, then every ASCII tab, LF and CR is removed,
// before the parser states run.
func Parse(input string) (*URL, error) {
	record, err := wurl.Parse(input)
	if err != nil {
		return nil, ErrInvalidURL
	}
	return &URL{record: record}, nil
}

// ParseRef is `new URL(input, base)`. A relative input resolves against base,
// including `..` path segments, a scheme-only reference and a protocol-relative
// `//host` reference. An invalid base makes every reference invalid, as it does
// in JavaScript.
func ParseRef(input, base string) (*URL, error) {
	record, err := wurl.ParseRef(base, input)
	if err != nil {
		return nil, ErrInvalidURL
	}
	return &URL{record: record}, nil
}

// CanParse is `URL.canParse(input)`: whether Parse would succeed without
// keeping the record.
func CanParse(input string) bool {
	_, err := wurl.Parse(input)
	return err == nil
}

// Clone returns an independent copy; setters on it do not affect u.
func (u *URL) Clone() *URL {
	return &URL{record: u.record.Clone()}
}

// Href is the URL serializer, including the fragment. JavaScript's
// `URL.prototype.href` and `toString()` both return it.
func (u *URL) Href() string { return u.record.Href(false) }

// String is `URL.prototype.toString()`, the same text as Href.
func (u *URL) String() string { return u.record.String() }

// Protocol is the scheme with its colon, in lower case (`https:`).
func (u *URL) Protocol() string { return u.record.Protocol() }

// Username is the percent-encoded user name, empty when there is none.
func (u *URL) Username() string { return u.record.Username() }

// Password is the percent-encoded password, empty when there is none.
func (u *URL) Password() string { return u.record.Password() }

// Host is the serialized host and, when it is not the scheme's default, the
// port (`example.com`, `[::1]:8080`).
func (u *URL) Host() string { return u.record.Host() }

// Hostname is the serialized host without the port. A domain is lower-case
// ASCII (punycode for non-ASCII labels); an IPv4 address is canonical dotted
// decimal; an IPv6 literal keeps its brackets.
func (u *URL) Hostname() string { return u.record.Hostname() }

// Port is the explicit port, empty when absent or the scheme's default.
func (u *URL) Port() string { return u.record.Port() }

// Pathname is the serialized path. For an opaque path (mailto:, data:, a
// custom scheme) it is that whole path.
func (u *URL) Pathname() string { return u.record.Pathname() }

// Search is `?` plus the serialized query. JavaScript returns "" for a URL
// with no query and for one whose query is the empty string, so `?` alone
// reports "" while Href keeps the `?`.
func (u *URL) Search() string { return u.record.Search() }

// Hash is `#` plus the serialized fragment; like Search it returns "" for an
// empty fragment, while Href keeps the `#`.
func (u *URL) Hash() string { return u.record.Hash() }

// SearchParams is the live query view: mutating it rewrites the URL's query.
func (u *URL) SearchParams() *SearchParams { return &SearchParams{params: u.record.SearchParams()} }

// SetHostname is `url.hostname = value`. A value the host parser rejects leaves
// the URL unchanged, as JavaScript does.
func (u *URL) SetHostname(value string) { u.record.SetHostname(value) }

// SetPathname is `url.pathname = value`; dot segments resolve and the path is
// percent-encoded with the path set.
func (u *URL) SetPathname(value string) { u.record.SetPathname(value) }

// SetHash is `url.hash = value`. A leading `#` in value is optional; the empty
// string removes the fragment.
func (u *URL) SetHash(value string) { u.record.SetHash(value) }

// SetSearch is `url.search = value`. A leading `?` is optional; the empty
// string removes the query.
func (u *URL) SetSearch(value string) { u.record.SetSearch(value) }

// SetHost is `url.host = value`: hostname and port together.
func (u *URL) SetHost(value string) { u.record.SetHost(value) }

// SetPort is `url.port = value`. A non-numeric value or one above 65535 leaves
// the port unchanged; the empty string removes it.
func (u *URL) SetPort(value string) { u.record.SetPort(value) }

// SetProtocol is `url.protocol = value`. A scheme change the standard forbids
// (special to non-special and back) leaves the URL unchanged.
func (u *URL) SetProtocol(value string) { u.record.SetProtocol(value) }

// SetUsername is `url.username = value`.
func (u *URL) SetUsername(value string) { u.record.SetUsername(value) }

// SetPassword is `url.password = value`.
func (u *URL) SetPassword(value string) { u.record.SetPassword(value) }

// SearchParams is a mutable application/x-www-form-urlencoded view of a query.
type SearchParams struct {
	params *wurl.SearchParams
}

// Get is `searchParams.get(name)`.
func (p *SearchParams) Get(name string) string { return p.params.Get(name) }

// Has is `searchParams.has(name)`.
func (p *SearchParams) Has(name string) bool { return p.params.Has(name) }

// Set is `searchParams.set(name, value)`: one pair, first position kept.
func (p *SearchParams) Set(name, value string) { p.params.Set(name, value) }

// Append is `searchParams.append(name, value)`.
func (p *SearchParams) Append(name, value string) { p.params.Append(name, value) }

// Delete is `searchParams.delete(name)`.
func (p *SearchParams) Delete(name string) { p.params.Delete(name) }

// String is `searchParams.toString()`: form-urlencoded serialization.
func (p *SearchParams) String() string { return p.params.String() }
