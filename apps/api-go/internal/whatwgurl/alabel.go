package whatwgurl

import (
	"errors"
	"math"
	"strings"
	"unicode"

	"golang.org/x/net/idna"
	"golang.org/x/text/unicode/norm"
)

// ErrInvalidALabel is returned when a special-scheme host contains an `xn--`
// label that Node/ICU rejects under UTS #46 section 4. Two upstream gaps make
// the check necessary:
//
//   - x/net/idna's fallback punycode-decodes the non-ASCII bytes before the
//     last hyphen as "basic" code points and re-encodes the label, so it
//     accepts `xn--bcüer-kva`; Node rejects any `xn--` label that is not
//     all-ASCII after mapping (step 4.1).
//   - its decoder rejects a delimiter at index zero (`xn---tda`), which ICU
//     accepts and decodes to "ü". That class is decoded and validated here and
//     the host is rewritten to its mapped ASCII form so the upstream ASCII
//     fast path accepts it.
//
// Steps 4.2-4.4 decode the rest and apply the section 4.1 validity criteria
// with CheckHyphens=false, VerifyDNSLength=false and UseSTD3ASCIIRules=false,
// as the URL Standard's domain-to-ASCII passes them. An all-ASCII host skips
// the gate because Node's fast path does not validate A-labels (`xn--a!` is
// accepted by both).
var ErrInvalidALabel = errors.New("whatwgurl: invalid A-label")

// errInvalidHost is returned when mapping an A-label host produces a domain
// code point the URL Standard forbids. Node rejects the host after
// domain-to-ASCII for the same reason.
var errInvalidHost = errors.New("whatwgurl: invalid host")

// alabelMapper is the WHATWG non-strict UTS #46 profile. It maps one non-ASCII
// code point at a time (a single code point can never itself be an `xn--`
// label, so that use never triggers A-label decoding), validates and encodes
// labels that are not A-labels, and applies the section 4.1 validity checks to
// a decoded A-label.
var alabelMapper = idna.New(
	idna.MapForLookup(),
	idna.VerifyDNSLength(false),
	idna.StrictDomainName(false),
	idna.CheckHyphens(false),
	idna.CheckJoiners(true),
	idna.BidiRule(),
	idna.Transitional(false),
)

// hostSpan is the half-open byte range of the host inside a preprocessed URL.
type hostSpan struct {
	start int
	end   int
}

// prepareAbsolute applies the A-label processing to an absolute URL and
// returns the string to hand to the upstream parser. Input preprocessing is
// idempotent, so the upstream parser sees the same URL.
func prepareAbsolute(raw string) (string, error) {
	input := preprocessURL(raw)
	span, ok := locateHost(input)
	if !ok {
		return input, nil
	}
	return prepareHost(input, span)
}

// prepareReference is ParseRef's counterpart. The base is prepared separately;
// only a reference that supplies its own host needs inspection here.
func prepareReference(base, ref string) (string, error) {
	reference := preprocessURL(ref)
	if _, _, ok := splitScheme(reference); ok {
		return prepareAbsolute(reference)
	}
	baseScheme, _, ok := splitScheme(preprocessURL(base))
	if !ok || !isSpecialScheme(baseScheme) {
		return reference, nil
	}
	if len(reference) < 2 || !isSlash(reference[0]) || !isSlash(reference[1]) {
		return reference, nil
	}
	span, ok := locateHostIn(baseScheme, reference, 0)
	if !ok {
		return reference, nil
	}
	return prepareHost(reference, span)
}

// locateHost returns the host range of a special-scheme absolute URL.
func locateHost(input string) (hostSpan, bool) {
	scheme, rest, ok := splitScheme(input)
	if !ok || !isSpecialScheme(scheme) {
		return hostSpan{}, false
	}
	return locateHostIn(scheme, rest, len(input)-len(rest))
}

// locateHostIn returns the host range for scheme data beginning at restStart.
// For file URLs only two leading slashes start a host and a third means an
// empty host. Every other special scheme skips all leading slashes and
// backslashes. The URL parser uses the last "@" as the userinfo boundary and
// the first ":" as the port boundary; bracketed hosts are IPv6, not domains.
func locateHostIn(scheme, rest string, restStart int) (hostSpan, bool) {
	if scheme == "file" {
		if len(rest) < 2 || !isSlash(rest[0]) || !isSlash(rest[1]) {
			return hostSpan{}, false
		}
		rest = rest[2:]
		restStart += 2
		if len(rest) > 0 && isSlash(rest[0]) {
			return hostSpan{}, false
		}
	} else {
		index := 0
		for index < len(rest) && isSlash(rest[index]) {
			index++
		}
		rest = rest[index:]
		restStart += index
	}
	authority := readAuthority(rest)
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
		restStart += at + 1
	}
	if authority == "" || authority[0] == '[' {
		return hostSpan{}, false
	}
	host := authority
	if colon := strings.IndexByte(host, ':'); colon >= 0 {
		host = host[:colon]
	}
	if host == "" {
		return hostSpan{}, false
	}
	return hostSpan{start: restStart, end: restStart + len(host)}, true
}

// prepareHost inspects a special-scheme host. An all-ASCII host takes Node's
// fast path, which does not validate A-labels. A non-ASCII host is mapped with
// UTS #46 and its A-labels are checked; when one has a leading-hyphen punycode
// payload, the host is replaced with its mapped ASCII form so the upstream
// parser's ASCII fast path accepts the label ICU accepts. Every A-label in a
// rewritten host is validated first, because the ASCII fast path performs no
// A-label checks.
func prepareHost(input string, span hostSpan) (string, error) {
	host := percentDecode(input[span.start:span.end])
	// The host parser removes a leading UTF-8 BOM from the domain.
	if strings.HasPrefix(host, "\xef\xbb\xbf") {
		host = host[3:]
	}
	if isASCII(host) {
		// Node's all-ASCII fast path does not validate A-labels.
		return input, nil
	}
	mapped := mapDomain(host)
	labels := strings.Split(mapped, ".")
	rewrite := false
	for _, label := range labels {
		if len(label) > 4 && strings.HasPrefix(label, "xn--") && label[4] == '-' {
			rewrite = true
			break
		}
	}
	if !rewrite {
		if hasInvalidACELabel(host) {
			return "", ErrInvalidALabel
		}
		return input, nil
	}
	asciiLabels := make([]string, len(labels))
	for index, label := range labels {
		if label == "" {
			asciiLabels[index] = ""
			continue
		}
		if strings.HasPrefix(label, "xn--") {
			if err := validateACELabel(label); err != nil {
				return "", err
			}
			asciiLabels[index] = label
			continue
		}
		ascii, err := alabelMapper.ToASCII(label)
		if err != nil {
			// Leave the decision to the upstream parser. This only happens for
			// table edges where x/net/idna and ICU disagree; not rewriting keeps
			// the existing behavior for them.
			return input, nil
		}
		asciiLabels[index] = ascii
	}
	asciiHost := strings.Join(asciiLabels, ".")
	if !isASCII(asciiHost) {
		return input, nil
	}
	if hasForbiddenDomainCodePoint(asciiHost) {
		return "", errInvalidHost
	}
	return input[:span.start] + asciiHost + input[span.end:], nil
}

// validateACELabel applies UTS #46 steps 4.1-4.4 to an A-label as ICU does
// when the domain contains non-ASCII: the label must be ASCII, decode as RFC
// 3492 punycode (a leading delimiter is valid), decode to a non-empty
// non-ASCII label, and the decoded label must be NFC, already mapped (no
// mapped/disallowed code points), free of label separators, and valid under
// the WHATWG profile's joiners/bidi rules.
func validateACELabel(label string) error {
	if !isASCII(label) {
		return ErrInvalidALabel
	}
	if label == "xn--" {
		return ErrInvalidALabel
	}
	decoded, ok := punycodeDecode(label[len("xn--"):])
	if !ok || decoded == "" || isASCII(decoded) {
		return ErrInvalidALabel
	}
	if strings.ContainsAny(decoded, ".\u3002\uff0e\uff61") {
		return ErrInvalidALabel
	}
	if !norm.NFC.IsNormalString(decoded) {
		return ErrInvalidALabel
	}
	if mapDomain(decoded) != decoded {
		return ErrInvalidALabel
	}
	if _, err := alabelMapper.ToASCII(decoded); err != nil {
		return ErrInvalidALabel
	}
	return nil
}

// hasForbiddenDomainCodePoint reports whether the domain contains a code point
// the URL Standard forbids after domain-to-ASCII.
func hasForbiddenDomainCodePoint(host string) bool {
	for _, r := range host {
		if r < 0x21 || r == 0x7f || strings.ContainsRune("#%/:<>?@[\\]^|", r) {
			return true
		}
	}
	return false
}

const (
	punyBase        = 36
	punyTMin        = 1
	punyTMax        = 26
	punySkew        = 38
	punyDamp        = 700
	punyInitialBias = 72
	punyInitialN    = 128
)

// punycodeDecode is RFC 3492 section 6.2. Unlike x/net/idna's decoder it
// accepts a delimiter at index zero, which means an empty basic part followed
// by encoded digits (ICU accepts `xn---tda` and decodes it to "ü").
func punycodeDecode(input string) (string, bool) {
	if input == "" {
		return "", true
	}
	var output []rune
	index := 0
	if delimiter := strings.LastIndexByte(input, '-'); delimiter >= 0 {
		for i := 0; i < delimiter; i++ {
			if input[i] >= 0x80 {
				return "", false
			}
			output = append(output, rune(input[i]))
		}
		index = delimiter + 1
	}
	n := rune(punyInitialN)
	i := 0
	bias := punyInitialBias
	for index < len(input) {
		oldi := i
		w := 1
		for k := punyBase; ; k += punyBase {
			if index >= len(input) {
				return "", false
			}
			digit := punyDigit(input[index])
			if digit < 0 {
				return "", false
			}
			index++
			if digit > (math.MaxInt-i)/w {
				return "", false
			}
			i += digit * w
			t := k - bias
			if t < punyTMin {
				t = punyTMin
			} else if t > punyTMax {
				t = punyTMax
			}
			if digit < t {
				break
			}
			if w > math.MaxInt/(punyBase-t) {
				return "", false
			}
			w *= punyBase - t
		}
		length := len(output) + 1
		bias = punyAdapt(i-oldi, length, oldi == 0)
		if i/length > math.MaxInt-int(n) {
			return "", false
		}
		n += rune(i / length)
		if n > unicode.MaxRune || (n >= 0xd800 && n <= 0xdfff) {
			return "", false
		}
		i %= length
		output = append(output, 0)
		copy(output[i+1:], output[i:])
		output[i] = n
		i++
	}
	return string(output), true
}

func punyDigit(c byte) int {
	switch {
	case 'a' <= c && c <= 'z':
		return int(c - 'a')
	case 'A' <= c && c <= 'Z':
		return int(c - 'A')
	case '0' <= c && c <= '9':
		return int(c-'0') + 26
	default:
		return -1
	}
}

func punyAdapt(delta, numPoints int, firstTime bool) int {
	if firstTime {
		delta /= punyDamp
	} else {
		delta /= 2
	}
	delta += delta / numPoints
	k := 0
	for delta > ((punyBase-punyTMin)*punyTMax)/2 {
		delta /= punyBase - punyTMin
		k += punyBase
	}
	return k + (punyBase-punyTMin+1)*delta/(delta+punySkew)
}

// hasInvalidACELabel applies the UTS #46 Map and NFC steps to the domain and
// reports whether a resulting label starts with "xn--" and either still
// contains a non-ASCII code point (step 4.1) or has an empty decoded label
// (step 4.3, `xn--` alone). The upstream profile covers the remaining decode
// and section 4.1 validity failures on this path.
func hasInvalidACELabel(host string) bool {
	mapped := mapDomain(host)
	for _, label := range strings.FieldsFunc(mapped, isLabelSeparator) {
		if !strings.HasPrefix(label, "xn--") {
			continue
		}
		if label == "xn--" || !isASCII(label) {
			return true
		}
	}
	return false
}

// mapDomain applies the UTS #46 mapping step and NFC. ASCII is mapped in
// place (A-Z to lowercase; every other ASCII code point is unchanged); each
// non-ASCII code point is mapped through the non-strict profile. Mapping is
// per code point in UTS #46, so isolated lookups are exact; NFC is applied
// once to the joined result.
func mapDomain(host string) string {
	var builder strings.Builder
	builder.Grow(len(host))
	for _, r := range host {
		if r < 0x80 {
			builder.WriteByte(lowerASCII(byte(r)))
			continue
		}
		mapped, _ := alabelMapper.ToUnicode(string(r))
		builder.WriteString(mapped)
	}
	return norm.NFC.String(builder.String())
}

// readAuthority reads up to the path, query or fragment delimiter.
func readAuthority(rest string) string {
	for index := 0; index < len(rest); index++ {
		switch rest[index] {
		case '/', '\\', '?', '#':
			return rest[:index]
		}
	}
	return rest
}

// preprocessURL applies the URL parser's input preprocessing: strip leading
// and trailing C0 controls and spaces, then remove ASCII tab and newline.
func preprocessURL(raw string) string {
	start, end := 0, len(raw)
	for start < end && raw[start] <= 0x20 {
		start++
	}
	for end > start && raw[end-1] <= 0x20 {
		end--
	}
	trimmed := raw[start:end]
	var builder strings.Builder
	builder.Grow(len(trimmed))
	for index := 0; index < len(trimmed); index++ {
		switch trimmed[index] {
		case '\t', '\n', '\r':
			continue
		}
		builder.WriteByte(trimmed[index])
	}
	return builder.String()
}

// splitScheme returns the lowercased scheme and the text after its colon.
func splitScheme(input string) (scheme, rest string, ok bool) {
	if input == "" || !isASCIIAlpha(input[0]) {
		return "", input, false
	}
	index := 1
	for index < len(input) && (isASCIIAlpha(input[index]) || isASCIIDigit(input[index]) ||
		input[index] == '+' || input[index] == '-' || input[index] == '.') {
		index++
	}
	if index >= len(input) || input[index] != ':' {
		return "", input, false
	}
	return strings.ToLower(input[:index]), input[index+1:], true
}

// specialSchemes are the schemes whose host parser runs domain-to-ASCII.
func isSpecialScheme(scheme string) bool {
	switch scheme {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	default:
		return false
	}
}

func isSlash(c byte) bool { return c == '/' || c == '\\' }

func isLabelSeparator(r rune) bool {
	switch r {
	case '.', '\u3002', '\uff0e', '\uff61':
		return true
	default:
		return false
	}
}

// percentDecode is the URL parser's percent-decode: valid escapes become
// bytes; an invalid escape is left as-is.
func percentDecode(input string) string {
	if !strings.Contains(input, "%") {
		return input
	}
	var builder strings.Builder
	builder.Grow(len(input))
	for index := 0; index < len(input); index++ {
		if input[index] == '%' && index+2 < len(input) &&
			isASCIIHex(input[index+1]) && isASCIIHex(input[index+2]) {
			builder.WriteByte(asciiHexValue(input[index+1])<<4 | asciiHexValue(input[index+2]))
			index += 2
			continue
		}
		builder.WriteByte(input[index])
	}
	return builder.String()
}

func isASCII(s string) bool {
	for index := 0; index < len(s); index++ {
		if s[index] >= 0x80 {
			return false
		}
	}
	return true
}

func isASCIIAlpha(c byte) bool { return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' }
func isASCIIDigit(c byte) bool { return '0' <= c && c <= '9' }

func isASCIIHex(c byte) bool {
	return isASCIIDigit(c) || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}

func asciiHexValue(c byte) byte {
	switch {
	case isASCIIDigit(c):
		return c - '0'
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

func lowerASCII(c byte) byte {
	if 'A' <= c && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}
