package shared

import (
	"errors"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// ErrUnsupportedURL means the origin is one JoinURL does not normalise (non-ASCII host,
// credentials): the deployment's WEB_ORIGIN is plain scheme://host[:port].
var ErrUnsupportedURL = errors.New("origin is not plain http(s)://host[:port]")

// JoinURL is `new URL(path, origin).toString()` for an absolute path against an http(s)
// origin, following the WHATWG URL standard's path, query and fragment states: ASCII tab and
// newline are dropped, leading and trailing control characters and spaces trimmed, `\` is a
// separator, dot segments resolve, and each part is percent-encoded with its own set.
func JoinURL(origin, path string) (string, error) {
	base, err := url.Parse(origin)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.Hostname() == "" {
		return "", ErrUnsupportedURL
	}
	host := strings.ToLower(base.Hostname())
	for _, character := range host {
		if character > 0x7e || character < 0x21 {
			return "", ErrUnsupportedURL
		}
	}
	if strings.Contains(host, ":") {
		// An IPv6 literal is served only in the form WHATWG serialises it (compressed, lower case).
		if address, err := netip.ParseAddr(host); err != nil || !address.Is6() || address.Is4In6() || address.String() != host {
			return "", ErrUnsupportedURL
		}
		host = "[" + host + "]"
	} else if last := host[strings.LastIndexByte(host, '.')+1:]; last == "" || (last[0] >= '0' && last[0] <= '9') {
		// A host ending in a number is an IPv4 candidate that WHATWG rewrites (127.1, 0x7f.1,
		// 2130706433): served only as a canonical dotted quad.
		if address, err := netip.ParseAddr(host); err != nil || !address.Is4() || address.String() != host {
			return "", ErrUnsupportedURL
		}
	}
	port := base.Port()
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number > 65535 {
			return "", ErrUnsupportedURL
		}
		if (base.Scheme == "http" && number == 80) || (base.Scheme == "https" && number == 443) {
			port = ""
		} else {
			port = ":" + strconv.Itoa(number)
		}
	}

	input := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, strings.TrimFunc(path, func(r rune) bool { return r <= 0x20 }))

	var fragment, query *string
	if index := strings.IndexByte(input, '#'); index >= 0 {
		text := input[index+1:]
		fragment = &text
		input = input[:index]
	}
	if index := strings.IndexByte(input, '?'); index >= 0 {
		text := input[index+1:]
		query = &text
		input = input[:index]
	}

	// input begins with "/": the path state starts after it.
	segments := []string{}
	rest := strings.TrimPrefix(input, "/")
	for {
		cut := strings.IndexAny(rest, `/\`)
		buffer, last := rest, cut < 0
		if !last {
			buffer = rest[:cut]
		}
		buffer = encode(buffer, inPath)
		switch lower := strings.ToLower(buffer); {
		case lower == ".." || lower == ".%2e" || lower == "%2e." || lower == "%2e%2e":
			if len(segments) > 0 {
				segments = segments[:len(segments)-1]
			}
			if last {
				segments = append(segments, "")
			}
		case lower == "." || lower == "%2e":
			if last {
				segments = append(segments, "")
			}
		default:
			segments = append(segments, buffer)
		}
		if last {
			break
		}
		rest = rest[cut+1:]
	}

	var out strings.Builder
	out.WriteString(base.Scheme + "://" + host + port)
	for _, segment := range segments {
		out.WriteString("/" + segment)
	}
	if query != nil {
		out.WriteString("?" + encode(*query, inQuery))
	}
	if fragment != nil {
		out.WriteString("#" + encode(*fragment, inFragment))
	}
	return out.String(), nil
}

type encodeSet int

const (
	inPath encodeSet = iota
	inQuery
	inFragment
)

// encode percent-encodes the characters the URL standard's path, special-query or fragment
// percent-encode set names (C0 controls and everything above ~ always), as UTF-8.
func encode(text string, set encodeSet) string {
	var out strings.Builder
	for _, character := range text {
		if character < 0x20 || character > 0x7e || needsEncoding(byte(character), set) {
			if character > 0x7e {
				for _, b := range []byte(string(character)) {
					out.WriteString(percent(b))
				}
				continue
			}
			out.WriteString(percent(byte(character)))
			continue
		}
		out.WriteRune(character)
	}
	return out.String()
}

func needsEncoding(b byte, set encodeSet) bool {
	switch b {
	case ' ', '"', '<', '>':
		return true
	case '?', '^', '{', '}':
		return set == inPath
	case '`':
		return set == inPath || set == inFragment
	case '\'':
		return set == inQuery
	}
	return false
}

func percent(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{'%', digits[b>>4], digits[b&0xf]})
}
