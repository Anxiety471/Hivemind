package effects

import (
	"errors"
	"math"
	"regexp"
	"strings"
)

// ErrUnredactable means a metadata value is outside the text this port can prove
// the TypeScript redactor leaves alone. redactBindings (packages/logging) is a
// stack of JavaScript-only regular expressions (lookbehind, backreferences) that
// RE2 cannot express, so Go accepts only values with no word the redactor could
// act on and refuses the rest rather than store something different.
var ErrUnredactable = errors.New("metadata value needs the TypeScript redactor")

var safeText = regexp.MustCompile(`^[A-Za-z0-9._-]*$`)

// Words the redactor keys on (SECRET_NAMES, email) and the prefixes of the keys
// it recognises in bare text. A value containing any, in any case, is refused.
var redactorWords = []string{
	"passw", "secret", "token", "authorization", "cookie", "credential",
	"api_key", "api-key", "apikey", "email",
	"sk-", "sk_", "ak_", "ck_", "eyj",
}

// redactText is redactSensitiveText for the plain identifiers Go records: names,
// kinds and ids made of letters, digits, dot, underscore and hyphen. Such text has
// no separator, address, URL, path or whitespace for a redaction rule to match.
func redactText(text string) (string, error) {
	if !safeText.MatchString(text) {
		return "", ErrUnredactable
	}
	lower := strings.ToLower(text)
	for _, word := range redactorWords {
		if strings.Contains(lower, word) {
			return "", ErrUnredactable
		}
	}
	return text, nil
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
	if number, ok := value.(int64); ok && number >= 0 && number <= math.MaxInt64 {
		switch strings.ReplaceAll(normalized, "_", "") {
		case "requestedmaxtokens", "effectivemaxtokens":
			return false
		}
	}
	return redactKeys[normalized] || secretKey.MatchString(normalized)
}
