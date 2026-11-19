package contentcrypto

import (
	"crypto/hmac"
	"crypto/sha256"
)

// hkdfSHA256 is RFC 5869 HKDF with SHA-256, matching node:crypto's hkdfSync for
// the two derivations content encryption uses. An empty salt means a salt of
// HashLen zeros, as RFC 5869 and Node both treat it.
func hkdfSHA256(ikm, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	extract := hmac.New(sha256.New, salt)
	extract.Write(ikm)
	prk := extract.Sum(nil)
	out := make([]byte, 0, length)
	var previous []byte
	for counter := byte(1); len(out) < length; counter++ {
		expand := hmac.New(sha256.New, prk)
		expand.Write(previous)
		expand.Write(info)
		expand.Write([]byte{counter})
		previous = expand.Sum(nil)
		out = append(out, previous...)
	}
	return out[:length]
}
