package whatwgurl

// UTS #46 host processing for the WHATWG URL parser.
//
// The upstream parser is kept for the WPT-tested URL state machine, but its
// domain-to-ASCII path uses x/net/idna, whose tables and Bidi/joiner data do
// not match the ICU build Node's URL implementation uses. For every special
// scheme and every host that is not all-ASCII after percent-decoding, this
// file rewrites the host with a project-owned UTS #46 implementation and hands
// the resulting ASCII host to the upstream ASCII fast path. An all-ASCII host
// is left untouched because Node's host parser also takes that fast path and
// does not validate A-labels there (`https://xn--a!/` is accepted by both).
// Opaque/non-special schemes are untouched because Node does not run
// domain-to-ASCII for them.
//
// The mapping, effective leading-code-point, and effective coarse Bidi data
// are generated from the running Node/ICU itself by
// tools/idna-mapping-cases.mts and tools/idna-bidi-cases.mts. Joining_Type and
// Virama come from the matching Unicode 17 UCD extracts because Node does not
// expose those properties. See idna_tables.go for the generation command.

import (
	"errors"
	"math"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ErrInvalidALabel is returned when a special-scheme host contains an `xn--`
// label that Node/ICU rejects under the UTS #46 processing steps. The label is
// decoded, then checked for a non-empty non-ASCII result, NFC, valid status
// values, the effective leading-code-point rule, ContextJ, and the decoded
// label's own `xn--` prefix; Bidi is checked at the domain level.
var ErrInvalidALabel = errors.New("whatwgurl: invalid A-label")

// errInvalidHost is returned when UTS #46 mapping or the URL Standard's
// forbidden-domain-code-point check rejects a non-ASCII host. Node throws for
// the same input.
var errInvalidHost = errors.New("whatwgurl: invalid host")

type hostSpan struct {
	start int
	end   int
}

// prepareAbsolute rewrites a non-ASCII special-scheme host and returns the
// string to hand to the upstream parser. Input preprocessing is idempotent,
// so the upstream parser sees the same URL.
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
	baseInput := preprocessURL(base)
	baseScheme, _, baseHasScheme := splitScheme(baseInput)
	if refScheme, refRest, hasScheme := splitScheme(reference); hasScheme {
		if !isSpecialScheme(refScheme) {
			return reference, nil
		}
		if hasAuthorityPrefix(refRest) {
			return prepareAbsolute(reference)
		}
		// The URL standard's "special relative or authority" state inherits
		// the base host when a special-scheme reference has fewer than two
		// leading slashes and the reference scheme equals the base scheme.
		// With a different (or non-special) base scheme, the same text is an
		// absolute special authority and the first segment is the host.
		if baseHasScheme && baseScheme == refScheme && isSpecialScheme(baseScheme) {
			return reference, nil
		}
		return prepareAbsolute(reference)
	}
	if !baseHasScheme || !isSpecialScheme(baseScheme) {
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

// hasAuthorityPrefix reports whether text after a scheme starts an authority
// for a special-scheme reference. One leading slash (or backslash) is the
// special-relative case, which inherits the base host and must not be
// rewritten as a host.
func hasAuthorityPrefix(rest string) bool {
	return len(rest) >= 2 && isSlash(rest[0]) && isSlash(rest[1])
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

// prepareHost applies UTS #46 to a special-scheme host that is not all-ASCII
// after percent-decoding, then rewrites the host span with the ASCII result.
// An all-ASCII host is left to the upstream fast path, which matches Node's
// behavior (including not validating all-ASCII A-labels).
func prepareHost(input string, span hostSpan) (string, error) {
	host := percentDecode(input[span.start:span.end])
	hadBOM := strings.HasPrefix(host, "\xef\xbb\xbf")
	if hadBOM {
		host = host[3:]
	}
	if isASCII(host) && !hadBOM {
		return input, nil
	}
	ascii, err := toASCII(host)
	if err != nil {
		return "", err
	}
	if ascii == "" {
		// An all-ignored host (for example U+00AD) is rejected by the URL
		// host parser as an empty special-scheme host.
		return "", errInvalidHost
	}
	if hasForbiddenDomainCodePoint(ascii) {
		return "", errInvalidHost
	}
	return input[:span.start] + ascii + input[span.end:], nil
}

// toASCII runs the UTS #46 processing steps with CheckHyphens=false,
// CheckJoiners=true, CheckBidi=true, UseSTD3ASCIIRules=false,
// Transitional=false, VerifyDNSLength=false and IgnoreInvalidPunycode=false,
// then converts non-ASCII labels to A-labels. The input is a decoded host
// (not a URL), already stripped of a leading BOM.
func toASCII(host string) (string, error) {
	mapped, err := mapDomain(host)
	if err != nil {
		return "", err
	}
	labels := strings.Split(mapped, ".")
	type labelInfo struct {
		ascii      string
		ulabel     string
		joinerFlag bool
	}
	infos := make([]labelInfo, len(labels))
	for index, label := range labels {
		if label == "" {
			continue
		}
		if strings.HasPrefix(label, "xn--") {
			decoded, ok := punycodeDecode(label[len("xn--"):])
			if !ok || decoded == "" || isASCII(decoded) {
				return "", ErrInvalidALabel
			}
			if strings.ContainsAny(decoded, ".") || strings.HasPrefix(decoded, "xn--") {
				return "", ErrInvalidALabel
			}
			if nfcDomain(decoded) != decoded {
				return "", ErrInvalidALabel
			}
			joinerFlag, err := validateULabel(decoded)
			if err != nil {
				return "", err
			}
			// A valid A-label is preserved rather than re-encoded: ICU keeps
			// `xn---tda` (which decodes to "ü") and only lowercases the
			// input, so a canonicalizing round-trip would differ from Node.
			infos[index] = labelInfo{ascii: label, ulabel: decoded, joinerFlag: joinerFlag}
			continue
		}
		joinerFlag, err := validateULabel(label)
		if err != nil {
			return "", err
		}
		if isASCII(label) {
			infos[index] = labelInfo{ascii: label, ulabel: label, joinerFlag: joinerFlag}
		} else {
			infos[index] = labelInfo{ascii: "xn--" + punycodeEncode(label), ulabel: label, joinerFlag: joinerFlag}
		}
	}

	bidiDomain := false
	for _, info := range infos {
		if labelHasBidiTrigger(info.ulabel) {
			bidiDomain = true
			break
		}
	}
	if bidiDomain {
		for _, info := range infos {
			// ICU applies the Bidi rule only to labels that themselves contain
			// an R/AL or AN code point. A label of only L/EN/NSM/neutral
			// characters (including ASCII labels and emoji-only labels) is
			// accepted even when another label makes the domain Bidi.
			if !labelHasBidiTrigger(info.ulabel) || info.joinerFlag {
				continue
			}
			if err := checkBidi(info.ulabel); err != nil {
				return "", err
			}
		}
	}

	out := make([]string, len(infos))
	for index, info := range infos {
		out[index] = info.ascii
	}
	return strings.Join(out, "."), nil
}

// mapDomain applies the UTS #46 Map step and NFC. Mapping is per code point;
// NFC is applied once to the joined result.
func mapDomain(host string) (string, error) {
	var builder strings.Builder
	builder.Grow(len(host))
	for _, r := range host {
		status, _, mapping := idnaMapping(r)
		switch status {
		case idnaStatusValid:
			builder.WriteRune(r)
		case idnaStatusMapped:
			builder.WriteString(mapping)
		case idnaStatusIgnored:
			// Ignored code points disappear.
		default:
			return "", errInvalidHost
		}
	}
	return nfcDomain(builder.String()), nil
}

// nfcDomain applies NFC the way ICU's UIDNA normalizer does. A small set of
// combining marks exists in the Unicode Character Database but not in the ICU
// version Node uses; ICU treats them as starters (canonical combining class 0)
// and does not reorder them. They are boundaries for canonical ordering, so
// normalizing the segments between them with Go's NFC reproduces that
// behavior. None of these code points has a canonical decomposition, so no
// composition with a following mark can be lost at a boundary.
func nfcDomain(s string) string {
	if s == "" {
		return ""
	}
	var out strings.Builder
	out.Grow(len(s))
	segment := make([]rune, 0, len(s))
	flush := func() {
		if len(segment) == 0 {
			return
		}
		out.WriteString(norm.NFC.String(string(segment)))
		segment = segment[:0]
	}
	for _, r := range s {
		if isNFCStarter(r) {
			flush()
			out.WriteRune(r)
			continue
		}
		segment = append(segment, r)
	}
	flush()
	return out.String()
}

// validateULabel applies the UTS #46 section 4.1 criteria that are checked
// per label, apart from the domain-level Bidi rule: non-empty labels are NFC,
// every code point has valid status, the effective leading-code-point rule
// holds, and ContextJ is satisfied. The returned flag reports whether a valid
// joiner was seen; ICU then exempts that label from the Bidi rule.
func validateULabel(label string) (bool, error) {
	if label == "" {
		return false, nil
	}
	if nfcDomain(label) != label {
		return false, ErrInvalidALabel
	}
	first := true
	for _, r := range label {
		status, firstAllowed, _ := idnaMapping(r)
		if status != idnaStatusValid {
			return false, ErrInvalidALabel
		}
		if first && !firstAllowed {
			return false, ErrInvalidALabel
		}
		first = false
	}
	return checkJoiners(label)
}

// labelHasBidiTrigger reports whether a label makes the domain a Bidi domain:
// it contains a code point of effective class R/AL or AN.
func labelHasBidiTrigger(label string) bool {
	for _, r := range label {
		switch idnaBidiClass(r) {
		case bidiClassRT, bidiClassAN:
			return true
		}
	}
	return false
}

// checkBidi applies the RFC 5893 Bidi Rule to one label of a Bidi domain,
// using the effective coarse classes derived from ICU. The coarse classes are
// sufficient: ES/CS/ET/ON/BN all behave identically, and R/AL are
// indistinguishable under the six rules. ICU ignores trailing joiners
// (Bidi class BN) when finding the end-of-label character, so they are skipped
// like NSM there.
func checkBidi(label string) error {
	if label == "" {
		return nil
	}
	first := uint8(bidiClassInvalid)
	last := uint8(bidiClassInvalid)
	hasEN, hasAN := false, false
	for _, r := range label {
		class := idnaBidiClass(r)
		if first == bidiClassInvalid {
			first = class
		}
		switch class {
		case bidiClassEN:
			hasEN = true
		case bidiClassAN:
			hasAN = true
		}
		if class != bidiClassNSM && r != '\u200C' && r != '\u200D' {
			last = class
		}
		if first == bidiClassL {
			switch class {
			case bidiClassL, bidiClassEN, bidiClassNSM, bidiClassNeutral:
			default:
				return errInvalidHost
			}
		} else if first == bidiClassRT {
			switch class {
			case bidiClassRT, bidiClassEN, bidiClassAN, bidiClassNSM, bidiClassNeutral:
			default:
				return errInvalidHost
			}
		} else if class == bidiClassInvalid {
			return errInvalidHost
		}
	}
	if hasEN && hasAN {
		return errInvalidHost
	}
	switch first {
	case bidiClassL:
		if last != bidiClassL && last != bidiClassEN {
			return errInvalidHost
		}
	case bidiClassRT:
		if last != bidiClassRT && last != bidiClassEN && last != bidiClassAN {
			return errInvalidHost
		}
	default:
		return errInvalidHost
	}
	return nil
}

// checkJoiners applies the ContextJ rules with the effective joining classes
// and label-level behavior of the ICU host parser. Joining_Type data in the
// Unicode Character Database is not what ICU's IDNA implementation uses for
// every code point (U+08B5 is Dual_Joining there but non-joining in ICU), so
// the left/right predicates come from Node-derived probes.
//
// A ZWNJ needs an L/D character before it and an R/D character after it,
// skipping joiners and characters that are neither left- nor right-joining.
// A ZWJ, or a ZWNJ immediately after a Virama, satisfies the context directly.
// Once one joiner is valid, ICU accepts every later joiner in the same label
// without a context check, and it exempts the label from the Bidi rule.
func checkJoiners(label string) (bool, error) {
	runes := []rune(label)
	seenValid := false
	for index, r := range runes {
		switch r {
		case '\u200D': // ZERO WIDTH JOINER
			if seenValid {
				continue
			}
			if index > 0 && isVirama(runes[index-1]) {
				seenValid = true
				continue
			}
			return false, ErrInvalidALabel
		case '\u200C': // ZERO WIDTH NON-JOINER
			if seenValid {
				continue
			}
			if index > 0 && isVirama(runes[index-1]) {
				seenValid = true
				continue
			}
			before := index - 1
			for before >= 0 && !joinerLeft(runes[before]) && !joinerRight(runes[before]) {
				before--
			}
			if before < 0 || !joinerLeft(runes[before]) {
				return false, ErrInvalidALabel
			}
			after := index + 1
			for after < len(runes) && !joinerLeft(runes[after]) && !joinerRight(runes[after]) {
				after++
			}
			if after >= len(runes) || !joinerRight(runes[after]) {
				return false, ErrInvalidALabel
			}
			seenValid = true
		}
	}
	return seenValid, nil
}

func idnaMapping(r rune) (status uint8, first bool, mapping string) {
	if r < 0 || r > unicode.MaxRune {
		return idnaStatusDisallowed, false, ""
	}
	lo, hi := 0, len(idnaRanges)-1
	for lo <= hi {
		mid := int(uint(lo+hi) >> 1)
		entry := &idnaRanges[mid]
		switch {
		case r < entry.lo:
			hi = mid - 1
		case r > entry.hi:
			lo = mid + 1
		default:
			if entry.status == idnaStatusMapped {
				off := entry.mapOff
				return entry.status, entry.first, idnaMappingBlob[off : off+entry.mapLen]
			}
			return entry.status, entry.first, ""
		}
	}
	// The generated table intentionally leaves the surrogate range out; the
	// URL host parser can never receive a decoded surrogate as a valid label
	// code point.
	return idnaStatusDisallowed, false, ""
}

func idnaBidiClass(r rune) uint8 {
	if r < 0 || r > unicode.MaxRune {
		return bidiClassInvalid
	}
	lo, hi := 0, len(bidiRanges)-1
	for lo <= hi {
		mid := int(uint(lo+hi) >> 1)
		entry := &bidiRanges[mid]
		switch {
		case r < entry.lo:
			hi = mid - 1
		case r > entry.hi:
			lo = mid + 1
		default:
			return entry.class
		}
	}
	return bidiClassInvalid
}

func isNFCStarter(r rune) bool {
	return inCodePointRanges(nfcStarterRanges[:], r)
}

func joinerLeft(r rune) bool {
	return inCodePointRanges(joinerLeftRanges[:], r)
}

func joinerRight(r rune) bool {
	return inCodePointRanges(joinerRightRanges[:], r)
}

func isVirama(r rune) bool {
	return inCodePointRanges(viramaRanges[:], r)
}

func inCodePointRanges(ranges []codePointRange, r rune) bool {
	if r < 0 || r > unicode.MaxRune {
		return false
	}
	lo, hi := 0, len(ranges)-1
	for lo <= hi {
		mid := int(uint(lo+hi) >> 1)
		entry := &ranges[mid]
		switch {
		case r < entry.lo:
			hi = mid - 1
		case r > entry.hi:
			lo = mid + 1
		default:
			return true
		}
	}
	return false
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

// punycodeEncode is RFC 3492 section 6.3.
func punycodeEncode(input string) string {
	runes := []rune(input)
	var out strings.Builder
	out.Grow(len(input) + 8)
	basic := 0
	for _, r := range runes {
		if r < 0x80 {
			out.WriteByte(byte(r))
			basic++
		}
	}
	if basic > 0 {
		out.WriteByte('-')
	}
	n := punyInitialN
	delta := 0
	bias := punyInitialBias
	handled := basic
	for handled < len(runes) {
		m := int(unicode.MaxRune)
		for _, r := range runes {
			if int(r) >= n && int(r) < m {
				m = int(r)
			}
		}
		delta += (m - n) * (handled + 1)
		n = m
		for _, r := range runes {
			if int(r) < n {
				delta++
			}
			if int(r) == n {
				q := delta
				for k := punyBase; ; k += punyBase {
					t := k - bias
					if t < punyTMin {
						t = punyTMin
					} else if t > punyTMax {
						t = punyTMax
					}
					if q < t {
						break
					}
					out.WriteByte(punyEncodeDigit(t + (q-t)%(punyBase-t)))
					q = (q - t) / (punyBase - t)
				}
				out.WriteByte(punyEncodeDigit(q))
				bias = punyAdapt(delta, handled+1, handled == basic)
				delta = 0
				handled++
			}
		}
		delta++
		n++
	}
	return out.String()
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

func punyEncodeDigit(d int) byte {
	if d < 26 {
		return byte('a' + d)
	}
	return byte('0' + d - 26)
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
