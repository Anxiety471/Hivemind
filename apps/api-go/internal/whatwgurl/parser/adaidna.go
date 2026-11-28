package urlparser

// Ada URL 4.0.0 IDNA compatibility.
//
// The pinned WHATWG parser uses golang.org/x/net/idna with idna.BidiRule(), which
// applies RFC 5893 to every label of a domain once one label is right-to-left.
// Node 24.22.3 uses Ada 4.0.0 (process.versions.ada), whose to_ascii follows the
// same UTS 46 mapping but applies the bidi rules only to a label that itself
// contains an R, AL or AN character (src/validity.cpp: `if (is_rtl_label(label))`).
// ASCII labels are appended unchecked, and a label that mapping turns into ASCII
// is skipped. That difference is observable: Node accepts `http://א._/`
// (hostname `xn--4db._`) and rejects `http://aא.example/`; x/net/idna rejects
// both. The differential proof in tools/infra-d-url-proof.mts found this on the
// generated IDN corpus.
//
// Ada also refuses a domain whose UTF-8 form exceeds 16 KiB
// (src/to_ascii.cpp: `max_domain_input_bytes`), for non-ASCII input. The URL
// host parser short-circuits ASCII domains (Node accepts a 70000-byte ASCII
// host), so the limit is applied only to non-ASCII domains.
//
// Everything else (mapping, NFC, disallowed code points, the combining-mark
// rule, ContextJ) stays with x/net/idna, whose profile the pinned parser builds
// without the bidi rule after this change.

import (
	"errors"
	"strings"

	"golang.org/x/text/unicode/bidi"
)

const adaMaxDomainInputBytes = 16384

var (
	errAdaDomainTooLong = errors.New("unicode ToASCII: domain exceeds 16384 bytes")
	errAdaBidi          = errors.New("unicode ToASCII: label fails the bidi rule")
	errAdaPunycode      = errors.New("unicode ToASCII: invalid punycode label")
)

// adaCheckDomain applies Ada 4.0.0's per-label bidi rule to the ASCII domain a
// ToASCII call produced. Only ACE labels need decoding: an ASCII label can
// never contain R, AL or AN, and Ada leaves such labels unchecked.
func adaCheckDomain(asciiDomain string) error {
	for label := range strings.SplitSeq(asciiDomain, ".") {
		if len(label) < 4 || !strings.EqualFold(label[:4], "xn--") {
			continue
		}
		decoded, ok := decodePunycode(label[4:])
		if !ok {
			return errAdaPunycode
		}
		allASCII := true
		for _, r := range decoded {
			if r >= 0x80 {
				allASCII = false
				break
			}
		}
		// Ada: an ACE label that decodes to ASCII, or to nothing, is invalid.
		if allASCII || len(decoded) == 0 {
			return errAdaPunycode
		}
		if !adaLabelValid(decoded) {
			return errAdaBidi
		}
	}
	return nil
}

func adaBidiClass(r rune) bidi.Class {
	properties, _ := bidi.LookupRune(r)
	return properties.Class()
}

// adaLabelValid is Ada 4.0.0's is_label_valid for a mapped label, restricted to
// the part x/net/idna no longer enforces: the RFC 5893 rules when the label is
// an RTL label. ContextJ and the first-combining-mark rule are still checked by
// x/net/idna before this runs.
func adaLabelValid(label []rune) bool {
	if !adaRTLLabel(label) {
		return true
	}
	last := -1
	for index := len(label) - 1; index >= 0; index-- {
		if adaBidiClass(label[index]) != bidi.NSM {
			last = index
			break
		}
	}
	if last < 0 {
		return false
	}
	first := adaBidiClass(label[0])
	if first == bidi.L {
		for index := range last + 1 {
			switch adaBidiClass(label[index]) {
			case bidi.L, bidi.EN, bidi.ES, bidi.CS, bidi.ET, bidi.ON, bidi.BN, bidi.NSM:
			default:
				return false
			}
		}
		end := adaBidiClass(label[last])
		return end == bidi.L || end == bidi.EN
	}
	if first != bidi.R && first != bidi.AL {
		return false
	}
	hasAN, hasEN := false, false
	for index := range last + 1 {
		class := adaBidiClass(label[index])
		switch class {
		case bidi.EN:
			hasEN = true
			if hasAN {
				return false
			}
		case bidi.AN:
			hasAN = true
			if hasEN {
				return false
			}
		}
		switch class {
		case bidi.R, bidi.AL, bidi.AN, bidi.EN, bidi.ES, bidi.CS, bidi.ET, bidi.ON, bidi.BN, bidi.NSM:
		default:
			return false
		}
		if index == last && class != bidi.R && class != bidi.AL && class != bidi.AN && class != bidi.EN {
			return false
		}
	}
	return true
}

func adaRTLLabel(label []rune) bool {
	for _, r := range label {
		switch adaBidiClass(r) {
		case bidi.R, bidi.AL, bidi.AN:
			return true
		}
	}
	return false
}

// decodePunycode is RFC 3492's decoding procedure over an ACE label after the
// "xn--" prefix. It reports false for any malformed input, overflowing
// arithmetic, a surrogate or a code point above U+10FFFF.
func decodePunycode(input string) ([]rune, bool) {
	const (
		base        = 36
		tMin        = 1
		tMax        = 26
		skew        = 38
		damp        = 700
		initialBias = 72
		initialN    = 128
	)
	out := make([]rune, 0, len(input))
	position := 0
	if delimiter := strings.LastIndexByte(input, '-'); delimiter >= 0 {
		for index := range delimiter {
			if input[index] >= 0x80 {
				return nil, false
			}
			out = append(out, rune(input[index]))
		}
		position = delimiter + 1
	}
	n := int64(initialN)
	bias := int64(initialBias)
	i := int64(0)
	for position < len(input) {
		oldI := i
		weight := int64(1)
		for k := int64(base); ; k += base {
			if position >= len(input) {
				return nil, false
			}
			digit, ok := punycodeDigit(input[position])
			if !ok {
				return nil, false
			}
			position++
			i += int64(digit) * weight
			if i > 0x7fffffff {
				return nil, false
			}
			threshold := k - bias
			if threshold < tMin {
				threshold = tMin
			}
			if threshold > tMax {
				threshold = tMax
			}
			if int64(digit) < threshold {
				break
			}
			weight *= base - threshold
			if weight > 0x7fffffff {
				return nil, false
			}
		}
		length := int64(len(out)) + 1
		bias = adaptPunycode(i-oldI, length, oldI == 0)
		n += i / length
		if n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) {
			return nil, false
		}
		i %= length
		out = append(out, 0)
		copy(out[i+1:], out[i:])
		out[i] = rune(n)
		i++
	}
	return out, true
}

func punycodeDigit(character byte) (int, bool) {
	switch {
	case character >= 'a' && character <= 'z':
		return int(character - 'a'), true
	case character >= 'A' && character <= 'Z':
		return int(character - 'A'), true
	case character >= '0' && character <= '9':
		return int(character-'0') + 26, true
	}
	return 0, false
}

func adaptPunycode(delta, numPoints int64, first bool) int64 {
	const (
		base = 36
		tMin = 1
		tMax = 26
		skew = 38
		damp = 700
	)
	if first {
		delta /= damp
	} else {
		delta /= 2
	}
	delta += delta / numPoints
	k := int64(0)
	for delta > ((base-tMin)*tMax)/2 {
		delta /= base - tMin
		k += base
	}
	return k + (base-tMin+1)*delta/(delta+skew)
}
