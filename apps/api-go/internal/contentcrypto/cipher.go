// Package contentcrypto is the Go side of Rakazo's at-rest content encryption
// (packages/db/src/content-crypto.ts): the versioned `rkz1:` envelope, the JSON
// column form that keeps queryable scalars beside the sealed original, the
// blind-index search tokens, the master-key hierarchy that wraps per-space data
// keys (content-keys.ts), and the per-model seal/open the Prisma extension
// performs. Ciphertext written here opens in TypeScript and the reverse; the
// contract proof tools/infra-a-proof.mts checks both directions.
package contentcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// CiphertextPrefix starts every sealed value; the space-key id follows it up to
// the next colon, then the base64url body (cipher.go / content-crypto.ts:10).
const CiphertextPrefix = "rkz1:"

// SealedField holds the ciphertext of a sealed JSON element; the scalar keys
// kept beside it are copies of the queryable fields (content-crypto.ts:12).
const SealedField = "$sealed"

const (
	// aadVersion is the first AAD field; changing it invalidates every value.
	aadVersion = "rakazo/content/v1"
	ivBytes    = 12
	tagBytes   = 16
)

// Decryption failures carry the same messages TypeScript throws, so a caller
// cannot tell which implementation refused a value.
var (
	// ErrDecryption is ContentDecryptionError's default message.
	ErrDecryption = errors.New("Encrypted content could not be decrypted")
	// ErrAnotherKey is a ciphertext sealed under a different space key.
	ErrAnotherKey = errors.New("Encrypted content names another key")
	// ErrAnotherSpace is a key that belongs to a different Space than the row.
	ErrAnotherSpace = errors.New("Encrypted content belongs to another space")
)

// DataKey is one space key version, unwrapped (content-crypto.ts:19-27).
type DataKey struct {
	// ID is the SpaceKey row id; every ciphertext header names it.
	ID string
	// SpaceID is the Space the key belongs to.
	SpaceID string
	// Version orders a Space's keys; the newest seals new content.
	Version int
	// Key is the 32-byte AES-256 key.
	Key []byte
}

// Location is what the AAD binds besides the Space (content-crypto.ts:29-35).
type Location struct {
	Table  string
	Column string
	RowID  string
	// Owner is the parent the row belongs to (thread, document or user), so a
	// row moved to another parent fails authentication.
	Owner string
}

// contentAAD is [aadVersion, table, column, rowId, owner, spaceId] joined with
// NUL (content-crypto.ts:48-51).
func contentAAD(location Location, spaceID string) []byte {
	return []byte(strings.Join(
		[]string{aadVersion, location.Table, location.Column, location.RowID, location.Owner, spaceID},
		"\x00",
	))
}

// IsCiphertext is isCiphertext (content-crypto.ts:53).
func IsCiphertext(value any) bool {
	_, ok := CiphertextKeyID(value)
	return ok
}

// CiphertextKeyID is ciphertextKeyId (content-crypto.ts:57-61): the id between
// the prefix and the next colon, empty or absent when value is not ciphertext.
func CiphertextKeyID(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || !strings.HasPrefix(text, CiphertextPrefix) {
		return "", false
	}
	rest := text[len(CiphertextPrefix):]
	end := strings.IndexByte(rest, ':')
	if end <= 0 {
		return "", false
	}
	return rest[:end], true
}

// EncryptText seals plaintext with a fresh IV (content-crypto.ts:63-70).
func EncryptText(key DataKey, location Location, plaintext string) (string, error) {
	// TypeScript encrypts a JS string, which is always valid UTF-16 and becomes
	// valid UTF-8 in Buffer.from(plaintext, "utf8"). Invalid bytes cannot have a
	// TS equivalent, so refuse them instead of storing something TS would have
	// sanitized differently.
	if !utf8.ValidString(plaintext) {
		return "", errors.New("content cipher: plaintext is not valid UTF-8")
	}
	block, err := aes.NewCipher(key.Key)
	if err != nil {
		return "", fmt.Errorf("content cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("content cipher: %w", err)
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("content iv: %w", err)
	}
	body := gcm.Seal(nil, iv, []byte(plaintext), contentAAD(location, key.SpaceID))
	// Go appends the tag, exactly like Buffer.concat([iv, enc, tag]).
	return CiphertextPrefix + key.ID + ":" + base64.RawURLEncoding.EncodeToString(append(iv, body...)), nil
}

// DecryptText opens one value (content-crypto.ts:72-92). The key must be the
// one the header names, and the body must carry IV, ciphertext and tag.
func DecryptText(key DataKey, location Location, value string) (string, error) {
	keyID, ok := CiphertextKeyID(value)
	if !ok || keyID != key.ID {
		return "", ErrAnotherKey
	}
	body := decodeBase64Lenient(value[len(CiphertextPrefix)+len(keyID)+1:])
	if len(body) < ivBytes+tagBytes {
		return "", ErrDecryption
	}
	block, err := aes.NewCipher(key.Key)
	if err != nil {
		return "", ErrDecryption
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", ErrDecryption
	}
	plaintext, err := gcm.Open(nil, body[:ivBytes], body[ivBytes:], contentAAD(location, key.SpaceID))
	if err != nil {
		return "", ErrDecryption
	}
	// Buffer#toString("utf8") replaces each maximal invalid subsequence with
	// U+FFFD; returning raw bytes would hand a caller a string JS cannot make.
	return decodeUTF8Node(plaintext), nil
}

// decodeUTF8Node is Buffer#toString("utf8"): a maximal invalid subsequence
// becomes one U+FFFD, following the Unicode replacement policy, rather than
// one replacement per invalid byte.
func decodeUTF8Node(value []byte) string {
	if utf8.Valid(value) {
		return string(value)
	}
	var builder strings.Builder
	builder.Grow(len(value) + utf8.UTFMax)
	for index := 0; index < len(value); {
		lead := value[index]
		if lead < utf8.RuneSelf {
			builder.WriteByte(lead)
			index++
			continue
		}
		width, low, high := 0, byte(0x80), byte(0xBF)
		switch {
		case lead >= 0xC2 && lead <= 0xDF:
			width = 2
		case lead == 0xE0:
			width, low = 3, 0xA0
		case lead >= 0xE1 && lead <= 0xEC:
			width = 3
		case lead == 0xED:
			width, high = 3, 0x9F
		case lead >= 0xEE && lead <= 0xEF:
			width = 3
		case lead == 0xF0:
			width, low = 4, 0x90
		case lead >= 0xF1 && lead <= 0xF3:
			width = 4
		case lead == 0xF4:
			width, high = 4, 0x8F
		}
		next := index + 1
		if width > 0 {
			for next < index+width && next < len(value) {
				unit := value[next]
				if next == index+1 {
					if unit < low || unit > high {
						break
					}
				} else if unit < 0x80 || unit > 0xBF {
					break
				}
				next++
			}
			if next == index+width {
				builder.Write(value[index:next])
				index = next
				continue
			}
		}
		builder.WriteRune(utf8.RuneError)
		index = next
	}
	return builder.String()
}

// decodeBase64Lenient is Buffer.from(value, "base64url") /
// Buffer.from(value, "base64") (content-crypto.ts:75, content-keys.ts:25):
// both alphabets are accepted, characters outside them are ignored, and a "="
// ends the input, after which everything is ignored, exactly as Node's decoder
// does. A trailing group of one character carries no whole byte and decodes to
// nothing.
func decodeBase64Lenient(value string) []byte {
	cleaned := make([]byte, 0, len(value))
	for index := range len(value) {
		character := value[index]
		if character == '=' {
			break
		}
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '+', character == '/':
			cleaned = append(cleaned, character)
		case character == '-':
			cleaned = append(cleaned, '+')
		case character == '_':
			cleaned = append(cleaned, '/')
		}
	}
	if len(cleaned)%4 == 1 {
		cleaned = cleaned[:len(cleaned)-1]
	}
	decoded := make([]byte, base64.RawStdEncoding.DecodedLen(len(cleaned)))
	size, err := base64.RawStdEncoding.Decode(decoded, cleaned)
	if err != nil {
		return nil
	}
	return decoded[:size]
}

// isRecord is content-crypto.ts:98-100: a non-null object that is not an array.
func isRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

// isSealedJSON is content-crypto.ts:102-104.
func isSealedJSON(value any) (string, bool) {
	record, ok := isRecord(value)
	if !ok {
		return "", false
	}
	sealed, ok := record[SealedField]
	if !ok || !IsCiphertext(sealed) {
		return "", false
	}
	text, _ := sealed.(string)
	return text, true
}

// SealJSON is sealJson (content-crypto.ts:111-128). Arrays seal per element
// (message blocks); anything else seals as one value. Each sealed element keeps
// copies of the plain keys so existing JSON filters still match, and the sealed
// copy is the source of truth on read.
func SealJSON(value any, plainKeys map[string]bool, seal func(string) (string, error)) (any, error) {
	one := func(item any) (any, error) {
		sealed := map[string]any{}
		if record, ok := isRecord(item); ok {
			for field := range plainKeys {
				fieldValue, present := record[field]
				if !present || fieldValue == nil {
					if present {
						sealed[field] = nil
					}
					continue
				}
				if isJSONScalar(fieldValue) {
					sealed[field] = fieldValue
				}
			}
		}
		plaintext, err := marshalJSON(item)
		if err != nil {
			return nil, err
		}
		ciphertext, err := seal(plaintext)
		if err != nil {
			return nil, err
		}
		sealed[SealedField] = ciphertext
		return sealed, nil
	}
	if items, ok := value.([]any); ok {
		out := make([]any, len(items))
		for index, item := range items {
			next, err := one(item)
			if err != nil {
				return nil, err
			}
			out[index] = next
		}
		return out, nil
	}
	return one(value)
}

// isJSONScalar is the typeof check sealJson uses: string, number or boolean.
// json.Number is how a caller keeps integers exact through a JSON round trip.
func isJSONScalar(value any) bool {
	switch value.(type) {
	case string, bool, float64, float32, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64, json.Number:
		return true
	}
	return false
}

// OpenJSON is openJson (content-crypto.ts:131-136). Plaintext elements pass
// through, so rows written before encryption stay readable.
func OpenJSON(value any, open func(string) (string, error)) (any, error) {
	one := func(item any) (any, error) {
		ciphertext, ok := isSealedJSON(item)
		if !ok {
			return item, nil
		}
		plaintext, err := open(ciphertext)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(strings.NewReader(plaintext))
		decoder.UseNumber()
		var parsed any
		if err := decoder.Decode(&parsed); err != nil {
			return nil, ErrDecryption
		}
		return parsed, nil
	}
	if items, ok := value.([]any); ok {
		out := make([]any, len(items))
		for index, item := range items {
			next, err := one(item)
			if err != nil {
				return nil, err
			}
			out[index] = next
		}
		return out, nil
	}
	return one(value)
}

// JSONKeyIDs is jsonKeyIds (content-crypto.ts:138-143).
func JSONKeyIDs(value any) []string {
	items, ok := value.([]any)
	if !ok {
		items = []any{value}
	}
	var ids []string
	for _, item := range items {
		ciphertext, ok := isSealedJSON(item)
		if !ok {
			continue
		}
		if id, ok := CiphertextKeyID(ciphertext); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// JSONNeedsSealing is jsonNeedsSealing (content-crypto.ts:145-149): empty
// arrays count as sealed.
func JSONNeedsSealing(value any) bool {
	items, ok := value.([]any)
	if !ok {
		items = []any{value}
	}
	for _, item := range items {
		if _, ok := isSealedJSON(item); !ok {
			return true
		}
	}
	return false
}

// marshalJSON encodes a decoded JSON value the way JSON.stringify would leave
// it parseable by TypeScript: no HTML escaping, and json.Number (or integer Go
// values) kept exact. Go sorts map keys; JSON.parse does not care, and the
// TS→Go direction never re-encodes, so this only shapes Go-written ciphertext.
func marshalJSON(value any) (string, error) {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", fmt.Errorf("content json: %w", err)
	}
	return strings.TrimSuffix(builder.String(), "\n"), nil
}
