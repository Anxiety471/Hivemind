package secretstore

import (
	"errors"
	"strings"
)

// DevEncryptionKeyPlaceholder is DEV_ENCRYPTION_KEY_PLACEHOLDER
// (packages/core/src/node/secrets-guard.ts:3): accepted only where dev secrets
// are allowed.
const DevEncryptionKeyPlaceholder = "dev-encryption-key"

// runtimeSecretsError is RUNTIME_SECRETS_ERROR (secrets-guard.ts:14-15).
const runtimeSecretsError = "Set BETTER_AUTH_SECRET and ENCRYPTION_KEY to long random strings " +
	"before starting Rakazo outside local development or tests."

// ResolveEncryptionKey is resolveEncryptionKey (env.ts:266-272,
// secrets-guard.ts:59-72): the raw ENCRYPTION_KEY value, untrimmed, with the
// development placeholder substituted only where dev secrets are allowed and
// refused otherwise. It is what a gateway should call before NewStore, so a
// service never seals values TypeScript would refuse to read.
func ResolveEncryptionKey(getenv func(string) string) (string, error) {
	value := getenv("ENCRYPTION_KEY")
	if trimJSString(value) == "" {
		if isDevSecretAllowed(getenv) {
			return DevEncryptionKeyPlaceholder, nil
		}
		return "", errors.New(runtimeSecretsError)
	}
	if !isDevSecretAllowed(getenv) && trimJSString(value) == DevEncryptionKeyPlaceholder {
		return "", errors.New(runtimeSecretsError)
	}
	return value, nil
}

// isDevSecretAllowed is isDevSecretAllowed (secrets-guard.ts:25-33).
func isDevSecretAllowed(getenv func(string) string) bool {
	if getenv("RAKAZO_ALLOW_DEV_SECRETS") == "1" {
		return true
	}
	if vitest := getenv("VITEST"); vitest == "true" || vitest == "1" {
		return true
	}
	nodeEnv := getenv("NODE_ENV")
	return nodeEnv == "development" || nodeEnv == "test"
}

// trimJSString is JavaScript's String#trim: ECMAScript WhiteSpace and
// LineTerminator plus U+FEFF, and *not* U+0085 (Go's unicode.IsSpace would
// strip it).
func trimJSString(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		switch r {
		case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0',
			'\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
			return true
		}
		return r >= '\u2000' && r <= '\u200A'
	})
}
