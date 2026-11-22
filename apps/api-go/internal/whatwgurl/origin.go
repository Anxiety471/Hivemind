package whatwgurl

import "strings"

// Origin is `URL.prototype.origin`.
//
// A tuple origin (scheme, host, port) serializes to the scheme, "://", the
// serialized host and the port when it is not the scheme's default. The URL
// standard gives tuple origins to ftp, http, https, ws and wss; every other
// scheme (file:, mailto:, data:, a custom scheme) has an opaque origin that
// JavaScript serializes as "null".
//
// A `blob:` URL stands for its inner URL, but only when that inner URL is
// http(s): Node reports `https://host` for `blob:https://host/x` and "null" for
// `blob:ftp://host/x`, `blob:file:///x` and `blob:blob:https://host/`. This is
// why packages/adapters/src/secrets/bot-secrets.ts:680-700 refuses every scheme
// except http and https after reading origin: `blob:https://host/x` would
// otherwise pass as `https://host` without being a page on it.
func (u *URL) Origin() string {
	scheme := strings.TrimSuffix(u.Protocol(), ":")
	if scheme == "blob" {
		path := u.Pathname()
		if path == "" {
			return "null"
		}
		inner, err := Parse(path)
		if err != nil {
			return "null"
		}
		innerScheme := strings.TrimSuffix(inner.Protocol(), ":")
		if innerScheme != "http" && innerScheme != "https" {
			return "null"
		}
		return inner.tupleOrigin()
	}
	switch scheme {
	case "ftp", "http", "https", "ws", "wss":
		return u.tupleOrigin()
	}
	return "null"
}

func (u *URL) tupleOrigin() string {
	// These schemes parse only with a non-empty host; an opaque-host URL is never
	// one of them.
	if u.Hostname() == "" {
		return "null"
	}
	return strings.TrimSuffix(u.Protocol(), ":") + "://" + u.Host()
}
