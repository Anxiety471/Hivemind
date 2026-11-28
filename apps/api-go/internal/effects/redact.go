package effects

import (
	"errors"
	"regexp"
	"strings"
)

// ErrUnredactable means a metadata value is outside the text this port can prove
// the TypeScript redactor leaves alone. redactBindings (packages/logging) is a
// stack of JavaScript-only regular expressions (lookbehind, backreferences) that
// RE2 cannot express, so Go accepts only values it can prove unchanged and
// refuses the rest rather than store something different.
var ErrUnredactable = errors.New("metadata value needs the TypeScript redactor")

// safeText is the character set of the identifiers audit metadata carries: letters,
// digits, dot, underscore and hyphen. Redaction rule by rule (packages/logging/src/
// redaction.ts:26-330):
//
//   - INVALID_HEADER_VALUE needs "Headers.append:" (space, colon);
//   - KEYED_SECRET needs a secret-named key followed by a separator (":" / "="), a
//     quote, a bracket or "Bearer"/a scheme, all absent here;
//   - BEARER needs a space; URL_CREDENTIALS needs "://"; PAGE_SHARE_LINK and the
//     profile paths need "/"; EMAIL needs "@";
//   - WRITTEN_MARKER needs "[" or one of the marker characters.
//
// What can match is BARE_SECRET_CANDIDATE: "sk-" or "sk_" followed by a key, an
// "ak_"/"ck_" key, or a JWT starting "eyJ". Those prefixes are refused outright,
// which is conservative only for candidates redactBareKey would leave alone
// ("ck_orders_amount_positive"); a refused request is declined to TypeScript, so
// nothing is dropped and the stored row stays byte-identical.
var safeText = regexp.MustCompile(`^[A-Za-z0-9._-]*$`)

// bareSecretPrefixes are the case-sensitive starts of BARE_SECRET_CANDIDATE.
var bareSecretPrefixes = []string{"sk-", "sk_", "ak_", "ck_", "eyJ"}

// redactText is redactSensitiveText for the plain identifiers Go records: it returns
// the text unchanged, or ErrUnredactable when the TypeScript redactor could alter it.
func redactText(text string) (string, error) {
	if !safeText.MatchString(text) {
		return "", ErrUnredactable
	}
	for _, prefix := range bareSecretPrefixes {
		if strings.Contains(text, prefix) {
			return "", ErrUnredactable
		}
	}
	return text, nil
}

// AuditedMetadataServable reports whether a procedure audit value survives the
// TypeScript redactor unchanged, after the same 200-unit cut securityEventMetadata
// applies (packages/db/src/account/security-events.ts:126-140). A procedure whose
// audited id fails this must decline the request (local.ErrDecline) so the gateway
// answers it from TypeScript; dropping the event instead is never allowed.
func AuditedMetadataServable(value string) bool {
	_, err := redactText(sliceUTF16(value, maxMetadataString))
	return err == nil
}

var redactKeys = map[string]bool{
	"email": true, "prompt": true, "message": true, "messages": true, "body": true, "content": true,
	"text": true, "blocks": true, "parts": true, "input": true, "output": true, "stdout": true,
	"stderr": true, "arguments": true, "transcript": true, "completion": true, "html": true,
	"markdown": true, "query": true, "rawheaders": true, "headers": true,
}

var secretKey = regexp.MustCompile(`passw(?:or)?d|secret|token|authorization|cookie|credential|api[_-]?key`)
var nonKeyChars = regexp.MustCompile(`[^a-z0-9_]`)

// shouldRedactKey is shouldRedactKey in redaction.ts for a string or boolean value.
func shouldRedactKey(key string, value any) bool {
	normalized := nonKeyChars.ReplaceAllString(strings.ToLower(key), "")
	if number, ok := value.(int64); ok && number >= 0 {
		switch strings.ReplaceAll(normalized, "_", "") {
		case "requestedmaxtokens", "effectivemaxtokens":
			return false
		}
	}
	return redactKeys[normalized] || secretKey.MatchString(normalized)
}
