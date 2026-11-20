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
	"math"
	"reflect"
	"strconv"
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
// Buffer.from(value, "base64") (content-crypto.ts:75, content-keys.ts:25).
// Node reads the string's UTF-16 code units and looks at each unit's low byte:
// '=' ends the input, the two alphabets' digits accumulate (with "-"/"_"
// mapped to "+"/"/"), and every other byte is ignored. A trailing group of one
// digit carries no whole byte and decodes to nothing. The low-byte rule is why
// a non-ASCII unit such as U+4E2D ("中", low byte '-') is a digit to Node.
func decodeBase64Lenient(value string) []byte {
	// Canonical unpadded URL-safe bodies, the common case, decode directly.
	if len(value)%4 != 1 && isCanonicalBase64URL(value) {
		if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
			return decoded
		}
	}
	cleaned := make([]byte, 0, len(value))
	process := func(unit byte) bool {
		switch {
		case unit == '=':
			return false
		case unit >= 'A' && unit <= 'Z',
			unit >= 'a' && unit <= 'z',
			unit >= '0' && unit <= '9',
			unit == '+', unit == '/':
			cleaned = append(cleaned, unit)
		case unit == '-':
			cleaned = append(cleaned, '+')
		case unit == '_':
			cleaned = append(cleaned, '/')
		}
		return true
	}
	for _, character := range value {
		if character <= 0xFFFF {
			if !process(byte(character)) {
				break
			}
			continue
		}
		// An astral code point is two UTF-16 code units to Node; each one's
		// low byte is processed in order.
		offset := character - 0x10000
		if !process(byte(0xD800+(offset>>10))) || !process(byte(0xDC00+(offset&0x3FF))) {
			break
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

// isCanonicalBase64URL reports whether every byte is an unpadded URL-safe
// base64 digit, so the strict decoder yields exactly what Node would.
func isCanonicalBase64URL(value string) bool {
	for index := range len(value) {
		character := value[index]
		if (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

// canonicalJSON converts Go-typed JSON values (typed slices, maps with other
// key types, structs) to the shapes encoding/json decodes JSON into: []any,
// map[string]any and scalars. That is what makes a []Block, []string or
// []map[string]any seal per element like a JS array and lets the blind-index
// walkers see typed blocks. Containers already in those shapes are returned
// unchanged, and copied only when a child changes, so decoded-JSON input
// allocates nothing.
func canonicalJSON(value any) any {
	switch typed := value.(type) {
	case nil, string, bool, json.Number,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return value
	case []any:
		var out []any
		for index, item := range typed {
			next := canonicalJSON(item)
			if out == nil && !sameJSONValue(next, item) {
				out = make([]any, len(typed))
				copy(out, typed)
			}
			if out != nil {
				out[index] = next
			}
		}
		if out != nil {
			return out
		}
		return typed
	case map[string]any:
		var out map[string]any
		for key, item := range typed {
			next := canonicalJSON(item)
			if out == nil && !sameJSONValue(next, item) {
				out = make(map[string]any, len(typed))
				for name, current := range typed {
					out[name] = current
				}
			}
			if out != nil {
				out[key] = next
			}
		}
		if out != nil {
			return out
		}
		return typed
	case []byte:
		// encoding/json writes a byte slice as a base64 string, and
		// Array.isArray(Buffer) is false: not a JSON array.
		return value
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Slice, reflect.Array:
		if reflected.Kind() == reflect.Slice && reflected.Type().Elem().Kind() == reflect.Uint8 {
			// encoding/json writes every byte slice, named or not, as a base64
			// string; Array.isArray(Buffer) is false.
			return value
		}
		out := make([]any, reflected.Len())
		for index := range out {
			out[index] = canonicalJSON(reflected.Index(index).Interface())
		}
		return out
	case reflect.Map:
		if reflected.Type().Key().Kind() == reflect.String {
			out := make(map[string]any, reflected.Len())
			iterator := reflected.MapRange()
			for iterator.Next() {
				out[iterator.Key().String()] = canonicalJSON(iterator.Value().Interface())
			}
			return out
		}
	case reflect.Pointer:
		if reflected.IsNil() {
			return nil
		}
		return canonicalJSON(reflected.Elem().Interface())
	case reflect.Struct:
	default:
		return value
	}
	// Structs (respecting their JSON tags), non-string-keyed maps and types
	// implementing Marshaler go through the same encoder that seals them.
	encoded, err := marshalJSON(value)
	if err != nil {
		return value
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return value
	}
	return decoded
}

// sameJSONValue reports whether canonicalJSON left a value untouched, so a
// container can be returned without copying.
func sameJSONValue(next, previous any) bool {
	if next == nil || previous == nil {
		return next == nil && previous == nil
	}
	nextValue, previousValue := reflect.ValueOf(next), reflect.ValueOf(previous)
	if nextValue.Type() != previousValue.Type() {
		return false
	}
	switch nextValue.Kind() {
	case reflect.Slice, reflect.Map, reflect.Pointer:
		return nextValue.Pointer() == previousValue.Pointer()
	}
	if !nextValue.Comparable() {
		return false
	}
	return nextValue.Equal(previousValue)
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
	return sealJSON(canonicalJSON(value), plainKeys, seal)
}

// sealJSON seals a value already in canonical JSON shape; SealRow canonicalizes
// a column once and calls this rather than canonicalizing it again.
func sealJSON(value any, plainKeys map[string]bool, seal func(string) (string, error)) (any, error) {
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
	value = canonicalJSON(value)
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
	value = canonicalJSON(value)
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
	value = canonicalJSON(value)
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

// normalizeJSONNumbers rewrites the number forms JSON.stringify would not
// write: negative zero becomes 0, and a non-finite number (NaN or ±Infinity,
// including a json.Number that overflows float64 such as "1e400") becomes null.
// Go's encoder would write "-0" or reject the non-finite value, and TypeScript
// would then read a different value than it wrote. Containers are copied only
// when a child changes.
func normalizeJSONNumbers(value any) (any, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil, true
		}
		if typed == 0 && math.Signbit(typed) {
			return float64(0), true
		}
	case float32:
		number := float64(typed)
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, true
		}
		if typed == 0 && math.Signbit(number) {
			return float32(0), true
		}
	case json.Number:
		number, err := strconv.ParseFloat(typed.String(), 64)
		if err == nil || errors.Is(err, strconv.ErrRange) {
			if math.IsNaN(number) || math.IsInf(number, 0) {
				return nil, true
			}
			if number == 0 && math.Signbit(number) {
				return json.Number("0"), true
			}
		}
	case []any:
		var out []any
		for index, item := range typed {
			next, changed := normalizeJSONNumbers(item)
			if !changed {
				continue
			}
			if out == nil {
				out = make([]any, len(typed))
				copy(out, typed)
			}
			out[index] = next
		}
		if out != nil {
			return out, true
		}
	case map[string]any:
		var out map[string]any
		for key, item := range typed {
			next, changed := normalizeJSONNumbers(item)
			if !changed {
				continue
			}
			if out == nil {
				out = make(map[string]any, len(typed))
				for name, current := range typed {
					out[name] = current
				}
			}
			out[key] = next
		}
		if out != nil {
			return out, true
		}
	}
	return value, false
}

// marshalJSON encodes a decoded JSON value the way JSON.stringify would leave
// it parseable by TypeScript: no HTML escaping, negative zero written as 0,
// non-finite numbers as null, and json.Number (or integer Go values) kept exact.
func marshalJSON(value any) (string, error) {
	normalized, _ := normalizeJSONNumbers(value)
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalized); err != nil {
		return "", fmt.Errorf("content json: %w", err)
	}
	return strings.TrimSuffix(builder.String(), "\n"), nil
}
