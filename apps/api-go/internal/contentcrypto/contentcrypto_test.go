package contentcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
)

// The vectors below were produced by the TypeScript implementation from the
// deployed checkout (packages/db/src/content-crypto.ts and content-keys.ts) and
// pin byte-level compatibility: TS ciphertext must open here byte-identically,
// and the blind-index tokens must be the same integers.
const (
	tsCiphertext = "rkz1:key-1:ocHhrhsyD1W4_HDHcPpoMAeLPeoFt1eBjtJcgFdOtU0w2VbWXsHFDYDQyEmFzjcb1x5qULgXGMR_XB99JTD4"
	tsPlaintext  = "Ship the Pelican <&> İstanbul 😀"

	tsSealedBlocks = `[
	{"kind":"text","status":"done","$sealed":"rkz1:key-1:_YcjXul8lr5tHtyy-D2qbFL8Jixj6jCBxybUuX00Ur_CaWYxSbSm_SCz0Z1YS5EshBIzValqN0A5wbkGVanb8RflqiVuriEGlO1GOnRcCHWTIeNcUa3TLQ7nrK5Eavp32Pev9bZCjgN32J_L"},
	{"kind":"steps","$sealed":"rkz1:key-1:BVFYnp_pHKyzh5gwWpUYPrklJ9AtttHbQ1IcO3ea-_lcB0WqzehxDIBQpzZNzK0B_NOnJ7oe8OQ5YksN-Je2cPo_VnrGOKE0M9G_wG7SPYtA5JIqMCtG3zSl4HsO6vjEClWMiX15vlz4cn9ciBz6OwLLIpvfaA8WbmhxFglW"},
	{"kind":"file","artifactId":"art-1","$sealed":"rkz1:key-1:Lc7aHz9DOOhXgjdnFFYox9BlvVAnAl-mIsyJtdF7COmzD5NnLm7nF-p2GhKR1OXAiugZODTPaLpZVvhfGk58B6inl3xpCyr6dwPGQp07TpfmDo6c50AMtvIMD6TQ"},
	{"kind":"text","$sealed":"rkz1:key-1:shU3NcVbdjO8f6Bya1Di7ntZBzA0YE2cPaN3Fiu2Cg3t6QyoUXwXX3TFG5xrpviarfKZwbc"}
]`

	tsOpenedBlocks = `[
	{"kind":"text","status":"done","text":"Pelican İstanbul 😀 report","extra":1},
	{"kind":"steps","steps":[{"label":"Search the web","note":"found pelican"},{"label":"Read file"}]},
	{"kind":"file","artifactId":"art-1","name":"photo.png","size":10},
	{"kind":"text","text":""}
]`

	tsWords = "Pelican İstanbul 😀 report\n\nphoto.png\nSearch the web\nRead file\nfound pelican"

	tsWrappedKey    = "Vj4OnKv1bcVzKk8lPpLRT36GeFmlcYgzbeRSjMjJtjTLlEsjl04xR7Cn5EBFKq1YRuznmKSJvU5qkGDD"
	tsWrappedVault  = "oJ71JwzFIQzesqo1T1bX4XL_GG_Qc9JqLoNx_1sRi8MmpVERRKCPTEcGmAV64vvmN5fx-ec_L5rgurp8"
	tsDataKeyHex    = "00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9"
	tsVaultDataKey  = "0909090909090909090909090909090909090909090909090909090909090909"
	tsMasterKeyHex  = "abababababababababababababababababababababababababababababababab"
	tsMasterKey2Hex = "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0"
	tsDerivedKeyHex = "6b6b7579f0a71055828f51f5da6f798c5aee037ef02b2ab87a3892e9cd3fcefe"
)

var (
	tsTokenStrings = []string{
		"text", "done", "Pelican İstanbul 😀 report", "steps", "Search the web",
		"found pelican", "Read file", "file", "art-1", "photo.png", "text", "",
	}
	tsMasterIDList = []string{"k2", "k1", "env"}
)

var tsTokens = []int32{
	-2129723644, -2081183167, -1982186860, -1976446752, -1942260965, -1889791735,
	-1862130694, -1789771627, -1762429765, -1686748275, -1486896260, -1343101770,
	-1242781036, -1211464546, -987901801, -964273923, -939060324, -915108953,
	-856186089, -843338648, -832013056, -672539591, -621708590, -486157607,
	-436797304, -428901662, -322755491, -270924630, -107240856, -84082456,
	-41465621, -33324932, 50706073, 114478495, 199553745, 244347987, 303316759,
	383048352, 419112418, 427053950, 435430539, 500929102, 566572376, 572151421,
	652077278, 678079960, 696663779, 743041648, 1024108334, 1079450720,
	1300831972, 1386169417, 1420963505, 1483519660, 1523521176, 1524648716,
	1543921504, 1724285686, 1739720284, 1748735570, 1756662982, 1883341579,
	1973020489, 2027384407,
}

func decodeJSON(t *testing.T, text string) any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return value
}

func testKey() DataKey {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index)
	}
	return DataKey{ID: "key-1", SpaceID: "space-1", Version: 1, Key: key}
}

func testLocation() Location {
	return Location{Table: "messages", Column: "blocks", RowID: "row-1", Owner: "thread-1"}
}

func TestDecryptTextOpensTypeScriptCiphertext(t *testing.T) {
	plaintext, err := DecryptText(testKey(), testLocation(), tsCiphertext)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plaintext != tsPlaintext {
		t.Fatalf("plaintext = %q, want %q", plaintext, tsPlaintext)
	}
}

func TestDecryptTextRejectsWrongAADKeyAndTampering(t *testing.T) {
	key := testKey()
	cases := []struct {
		name     string
		key      DataKey
		location Location
		value    string
		want     error
	}{
		{"wrong owner", key, Location{Table: "messages", Column: "blocks", RowID: "row-1", Owner: "thread-2"}, tsCiphertext, ErrDecryption},
		{"wrong column", key, Location{Table: "messages", Column: "toolHistory", RowID: "row-1", Owner: "thread-1"}, tsCiphertext, ErrDecryption},
		{"wrong row", key, Location{Table: "messages", Column: "blocks", RowID: "row-2", Owner: "thread-1"}, tsCiphertext, ErrDecryption},
		{"wrong space", DataKey{ID: "key-1", SpaceID: "space-2", Version: 1, Key: key.Key}, testLocation(), tsCiphertext, ErrDecryption},
		{"another key id", DataKey{ID: "key-2", SpaceID: "space-1", Version: 1, Key: key.Key}, testLocation(), tsCiphertext, ErrAnotherKey},
		{"tampered body", key, testLocation(), tsCiphertext[:len(tsCiphertext)-1] + "A", ErrDecryption},
		{"truncated", key, testLocation(), "rkz1:key-1:AAAA", ErrDecryption},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := DecryptText(testCase.key, testCase.location, testCase.value); !errors.Is(err, testCase.want) {
				t.Fatalf("error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestOpenJSONOpensTypeScriptBlocks(t *testing.T) {
	sealed := decodeJSON(t, tsSealedBlocks)
	opened, err := OpenJSON(sealed, func(ciphertext string) (string, error) {
		return DecryptText(testKey(), testLocation(), ciphertext)
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	want := decodeJSON(t, tsOpenedBlocks)
	if !reflect.DeepEqual(opened, want) {
		t.Fatalf("opened blocks differ:\n got %#v\nwant %#v", opened, want)
	}
}

func TestSealJSONKeepsPlainKeys(t *testing.T) {
	blocks := decodeJSON(t, tsOpenedBlocks).([]any)
	sealed, err := SealJSON(blocks, messageBlockPlainKeys, func(plaintext string) (string, error) {
		return EncryptText(testKey(), testLocation(), plaintext)
	})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	items := sealed.([]any)
	first := items[0].(map[string]any)
	if first["kind"] != "text" || first["status"] != "done" {
		t.Fatalf("plain keys not kept: %#v", first)
	}
	if _, ok := first["text"]; ok {
		t.Fatalf("sealed element kept the full plaintext: %#v", first)
	}
	opened, err := OpenJSON(sealed, func(ciphertext string) (string, error) {
		return DecryptText(testKey(), testLocation(), ciphertext)
	})
	if err != nil {
		t.Fatalf("open sealed: %v", err)
	}
	if !reflect.DeepEqual(opened, blocks) {
		t.Fatalf("round trip differs")
	}
}

func TestSearchTokensMatchTypeScript(t *testing.T) {
	tokens := SearchTokens(testKey(), tsWords, tsTokenStrings)
	if !reflect.DeepEqual(tokens, tsTokens) {
		t.Fatalf("tokens differ:\n got %v\nwant %v", tokens, tsTokens)
	}
}

func TestQuerySearchTokensMatchTypeScript(t *testing.T) {
	words := QuerySearchTokens(testKey(), "pelican SHIP", DomainWord)
	if want := []int32{678079960, 370436526}; !reflect.DeepEqual(words, want) {
		t.Fatalf("word tokens = %v, want %v", words, want)
	}
	prefixes := QuerySearchTokens(testKey(), "peli rep eli 😀", DomainPrefix)
	if want := []int32{1300831972, 696663779, 514127669}; !reflect.DeepEqual(prefixes, want) {
		t.Fatalf("prefix tokens = %v, want %v", prefixes, want)
	}
	if got := QuerySearchTokens(testKey(), "x", DomainPrefix); len(got) != 0 {
		t.Fatalf("single-character prefix should not be indexed, got %v", got)
	}
}

func TestHistorySearchTextMatchesTypeScript(t *testing.T) {
	blocks := decodeJSON(t, tsOpenedBlocks)
	if got := HistorySearchText(blocks); got != tsWords {
		t.Fatalf("history text = %q, want %q", got, tsWords)
	}
}

func TestMasterKeysFromEnvMatchTypeScript(t *testing.T) {
	getenv := func(name string) string {
		switch name {
		case "ENCRYPTION_KEY":
			return "test-encryption-key-0123456789abcdef"
		case "ENCRYPTION_MASTER_KEYS":
			return "k2:" + tsMasterKeyHex + ",k1://79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA="
		}
		return ""
	}
	keys, err := MasterKeysFromEnv(getenv)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	ids := make([]string, len(keys))
	for index, key := range keys {
		ids[index] = key.ID
	}
	if !reflect.DeepEqual(ids, tsMasterIDList) {
		t.Fatalf("ids = %v, want %v", ids, tsMasterIDList)
	}
	if got := hexString(keys[0].Key); got != tsMasterKeyHex {
		t.Fatalf("active key = %s", got)
	}
	if got := hexString(keys[1].Key); got != tsMasterKey2Hex {
		t.Fatalf("second key = %s", got)
	}
	if got := hexString(keys[2].Key); got != tsDerivedKeyHex {
		t.Fatalf("derived key = %s", got)
	}
}

func TestLocalKeyProviderUnwrapsTypeScriptWraps(t *testing.T) {
	keys, err := MasterKeysFromEnv(func(name string) string {
		if name == "ENCRYPTION_KEY" {
			return "test-encryption-key-0123456789abcdef"
		}
		if name == "ENCRYPTION_MASTER_KEYS" {
			return "k2:" + tsMasterKeyHex
		}
		return ""
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	provider, err := NewLocalKeyProvider(keys)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	if provider.ActiveKeyID() != "k2" {
		t.Fatalf("active key = %s", provider.ActiveKeyID())
	}
	dataKey, err := provider.Unwrap(WrappedDataKey{MasterKeyID: "k2", WrappedKey: tsWrappedKey},
		KeyWrapContext{SpaceID: "space-1", Version: 2})
	if err != nil {
		t.Fatalf("unwrap: %v", err)
	}
	if got := hexString(dataKey); got != tsDataKeyHex {
		t.Fatalf("data key = %s", got)
	}
	vaultKey, err := provider.Unwrap(WrappedDataKey{MasterKeyID: "k2", WrappedKey: tsWrappedVault},
		KeyWrapContext{SpaceID: "user:u1", Version: 1})
	if err != nil {
		t.Fatalf("unwrap vault: %v", err)
	}
	if got := hexString(vaultKey); got != tsVaultDataKey {
		t.Fatalf("vault key = %s", got)
	}
	if _, err := provider.Unwrap(WrappedDataKey{MasterKeyID: "k2", WrappedKey: tsWrappedKey},
		KeyWrapContext{SpaceID: "space-2", Version: 2}); err == nil {
		t.Fatal("a wrap moved to another Space must not unwrap")
	}
}

func TestEncryptRoundTripAndJSONHelpers(t *testing.T) {
	key := testKey()
	ciphertext, err := EncryptText(key, testLocation(), "")
	if err != nil {
		t.Fatalf("encrypt empty: %v", err)
	}
	plaintext, err := DecryptText(key, testLocation(), ciphertext)
	if err != nil || plaintext != "" {
		t.Fatalf("empty round trip = %q, %v", plaintext, err)
	}
	if !IsCiphertext(ciphertext) {
		t.Fatal("ciphertext not recognised")
	}
	if IsCiphertext("rkz1:") || IsCiphertext("plain") || IsCiphertext(nil) {
		t.Fatal("non-ciphertext recognised")
	}
	sealed := map[string]any{"$sealed": ciphertext}
	if ids := JSONKeyIDs([]any{sealed, "plain"}); !reflect.DeepEqual(ids, []string{"key-1"}) {
		t.Fatalf("key ids = %v", ids)
	}
	if JSONNeedsSealing([]any{sealed}) || !JSONNeedsSealing([]any{sealed, "plain"}) || JSONNeedsSealing([]any{}) {
		t.Fatal("JSONNeedsSealing wrong")
	}
}

func hexString(value []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(value)*2)
	for _, character := range value {
		out = append(out, digits[character>>4], digits[character&0x0f])
	}
	return string(out)
}

func TestDecodeBase64LenientMatchesNode(t *testing.T) {
	// Buffer.from(value, "base64"/"base64url"): both alphabets, characters
	// outside them ignored, "=" ends the input, and a trailing one-character
	// group decodes to nothing. Expected values come from Node 24.
	cases := map[string]string{
		"AB==":       "00",
		"AB":         "00",
		"AB!CD":      "001083",
		"-_":         "fb",
		"+/":         "fb",
		"%%%":        "",
		"A":          "",
		"AB=CD":      "00",
		"A=B=":       "",
		"Q=UJD":      "",
		"QUJ=D":      "4142",
		"QQ==QQ==":   "41",
		"QU=JD":      "41",
		"=QUJD":      "",
		"QUJD=":      "414243",
		"QUJD==x":    "414243",
		"A A":        "00",
		" QUJD":      "414243",
		"QUJD\nQUJD": "414243414243",
		// Node reads UTF-16 code units and uses each unit's low byte: 中 is
		// '-', Ł and ａ are 'A', U+013D and U+FE3D are '=', and 😀 expands to
		// surrogates whose low bytes are '=' then 0x00.
		"QUJD中QUJD":      "414243f90509",
		"QUJDŁQUJD":      "414243010509",
		"QUJDａQUJD":      "414243010509",
		"QUJD\u013DQUJD": "414243",
		"QUJD︽QUJD":      "414243",
		"QUJDéQUJD":      "414243414243",
		"A😀B":            "",
		"AA😀AA":          "00",
		// 40 'A' digits then non-ASCII units: Node reads 'A', 'C', 'A' from
		// Ł/Ń/Ł, then '=' from Ľ and stops, yielding 32 bytes ending 0020.
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAŁŃŁĽGTA": "0000000000000000000000000000000000000000000000000000000000000020",
	}
	for input, wantHex := range cases {
		got := hexString(decodeBase64Lenient(input))
		if got != wantHex {
			t.Fatalf("decode %q = %q, want %q", input, got, wantHex)
		}
	}
}

func TestDecryptTextAcceptsNodeBase64Forms(t *testing.T) {
	const prefix = "rkz1:key-1:"
	body := tsCiphertext[len(prefix):]
	standard := strings.NewReplacer("-", "+", "_", "/").Replace(body)
	variants := map[string]string{
		"standard alphabet with padding": standard + "==",
		"junk characters inserted":       body[:10] + "!!" + body[10:],
		"standard alphabet with junk":    standard[:5] + " %%" + standard[5:] + "=",
		// Node's decoder stops at the first "=", so the repeated body is ignored
		// and the first, valid body still opens.
		"padding ends the input": body + "=" + body,
	}
	for name, value := range variants {
		plaintext, err := DecryptText(testKey(), testLocation(), prefix+value)
		if err != nil || plaintext != tsPlaintext {
			t.Fatalf("%s: %q, %v", name, plaintext, err)
		}
	}
}

func TestMasterKeysAcceptNodeBase64Forms(t *testing.T) {
	material, err := hex.DecodeString(tsMasterKey2Hex)
	if err != nil {
		t.Fatalf("vector: %v", err)
	}
	// Buffer.from(value, "base64") accepts the URL-safe alphabet, padding and
	// junk, and stops at the first "=" (content-keys.ts:25).
	encoded := base64.RawURLEncoding.EncodeToString(material)
	values := []string{
		encoded,
		encoded[:20] + "!?" + encoded[20:] + "==",
		strings.NewReplacer("-", "+", "_", "/").Replace(encoded),
		encoded + "=" + encoded,
	}
	for _, value := range values {
		keys, err := MasterKeysFromEnv(func(name string) string {
			if name == "ENCRYPTION_KEY" {
				return "test-encryption-key-0123456789abcdef"
			}
			if name == "ENCRYPTION_MASTER_KEYS" {
				return "k1:" + value
			}
			return ""
		})
		if err != nil {
			t.Fatalf("parse %q: %v", value, err)
		}
		if got := hexString(keys[0].Key); got != tsMasterKey2Hex {
			t.Fatalf("parse %q = %s, want %s", value, got, tsMasterKey2Hex)
		}
	}
}

// sealRawBytes makes a valid envelope around arbitrary plaintext bytes, as the
// TypeScript side would have if it could hold invalid UTF-8.
func sealRawBytes(t *testing.T, key DataKey, location Location, plaintext []byte) string {
	t.Helper()
	block, err := aes.NewCipher(key.Key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, ivBytes)
	body := gcm.Seal(nil, iv, plaintext, contentAAD(location, key.SpaceID))
	return CiphertextPrefix + key.ID + ":" + base64.RawURLEncoding.EncodeToString(append(iv, body...))
}

func TestDecodeUTF8MatchesNode(t *testing.T) {
	// Expected values are Buffer.from(bytes).toString("utf8") from Node 24:
	// one U+FFFD per maximal invalid subsequence, not per invalid byte.
	cases := []struct{ hex, want string }{
		{"e0a441", "\uFFFDA"},
		{"f09f98", "\uFFFD"},
		{"c080", "\uFFFD\uFFFD"},
		{"eda080", "\uFFFD\uFFFD\uFFFD"},
		{"f4908080", "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"8080", "\uFFFD\uFFFD"},
		{"e08080", "\uFFFD\uFFFD\uFFFD"},
		{"f0808080", "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"41e28241", "A\uFFFDA"},
		{"c2", "\uFFFD"},
		{"e282", "\uFFFD"},
		{"f09f", "\uFFFD"},
		{"f09f9880", "😀"},
		{"feff", "\uFFFD\uFFFD"},
	}
	for _, testCase := range cases {
		raw, err := hex.DecodeString(testCase.hex)
		if err != nil {
			t.Fatalf("vector %s: %v", testCase.hex, err)
		}
		if got := decodeUTF8Node(raw); got != testCase.want {
			t.Fatalf("decode %s = %q, want %q", testCase.hex, got, testCase.want)
		}
	}
}

func TestDecryptTextReplacesInvalidUTF8LikeNode(t *testing.T) {
	key, location := testKey(), testLocation()
	cases := []struct{ hex, want string }{
		{"e0a441", "\uFFFDA"},
		{"eda080", "\uFFFD\uFFFD\uFFFD"},
		{"41e28241", "A\uFFFDA"},
	}
	for _, testCase := range cases {
		raw, err := hex.DecodeString(testCase.hex)
		if err != nil {
			t.Fatalf("vector %s: %v", testCase.hex, err)
		}
		got, err := DecryptText(key, location, sealRawBytes(t, key, location, raw))
		if err != nil {
			t.Fatalf("decrypt %s: %v", testCase.hex, err)
		}
		if got != testCase.want {
			t.Fatalf("decrypt %s = %q, want %q", testCase.hex, got, testCase.want)
		}
	}
}

func TestEncryptTextRejectsInvalidUTF8(t *testing.T) {
	if _, err := EncryptText(testKey(), testLocation(), string([]byte{0xff})); err == nil {
		t.Fatal("invalid UTF-8 plaintext must be rejected")
	}
}

func TestSealJSONWritesNegativeZeroLikeJSONStringify(t *testing.T) {
	negativeZero := math.Copysign(0, -1)
	identity := func(plaintext string) (string, error) { return plaintext, nil }
	cases := []struct {
		name  string
		value any
		want  string
	}{
		{"float64", map[string]any{"n": negativeZero}, `{"n":0}`},
		{"number", map[string]any{"n": json.Number("-0")}, `{"n":0}`},
		{"number with exponent", map[string]any{"n": json.Number("-0e3")}, `{"n":0}`},
		{"nested", map[string]any{"a": []any{json.Number("-0.0"), json.Number("1.5")}}, `{"a":[0,1.5]}`},
		{"positive values unchanged", map[string]any{"n": json.Number("0"), "m": json.Number("-2")}, `{"m":-2,"n":0}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			sealed, err := SealJSON(testCase.value, nil, identity)
			if err != nil {
				t.Fatalf("seal: %v", err)
			}
			record, ok := sealed.(map[string]any)
			if !ok {
				t.Fatalf("sealed value is %T", sealed)
			}
			got, _ := record[SealedField].(string)
			if got != testCase.want {
				t.Fatalf("sealed plaintext = %q, want %q", got, testCase.want)
			}
		})
	}
}

type typedStep struct {
	Label string `json:"label"`
	Note  string `json:"note,omitempty"`
}

type typedBlock struct {
	Kind   string      `json:"kind"`
	Text   string      `json:"text,omitempty"`
	Status string      `json:"status,omitempty"`
	Steps  []typedStep `json:"steps,omitempty"`
}

func TestSealJSONTreatsTypedSlicesAsArrays(t *testing.T) {
	key, location := testKey(), testLocation()
	seal := func(plaintext string) (string, error) { return EncryptText(key, location, plaintext) }
	open := func(ciphertext string) (string, error) { return DecryptText(key, location, ciphertext) }
	blocks := []typedBlock{
		{Kind: "text", Text: "Pelican <&>", Status: "done"},
		{Kind: "steps", Steps: []typedStep{{Label: "Search", Note: "found"}}},
	}
	sealed, err := SealJSON(blocks, messageBlockPlainKeys, seal)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	items, ok := sealed.([]any)
	if !ok || len(items) != len(blocks) {
		t.Fatalf("typed slice sealed as %T, want %d-element array", sealed, len(blocks))
	}
	first := items[0].(map[string]any)
	if first["kind"] != "text" || first["status"] != "done" {
		t.Fatalf("plain keys not kept: %#v", first)
	}
	if _, ok := first["text"]; ok {
		t.Fatalf("sealed element kept the plaintext: %#v", first)
	}
	wantFirst := `{"kind":"text","status":"done","text":"Pelican <&>"}`
	if got, err := open(first[SealedField].(string)); err != nil || got != wantFirst {
		t.Fatalf("first seal opens as %q, %v; want %q", got, err, wantFirst)
	}

	opened, err := OpenJSON(sealed, open)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	want := []any{
		map[string]any{"kind": "text", "status": "done", "text": "Pelican <&>"},
		map[string]any{"kind": "steps", "steps": []any{
			map[string]any{"label": "Search", "note": "found"},
		}},
	}
	if !reflect.DeepEqual(opened, want) {
		t.Fatalf("opened = %#v, want %#v", opened, want)
	}
}

func TestTypedSlicesKeepHistoryTextAndTokens(t *testing.T) {
	typed := []typedBlock{
		{Kind: "text", Text: "Pelican İstanbul 😀 report", Status: "done"},
		{Kind: "steps", Steps: []typedStep{{Label: "Search the web", Note: "found pelican"}, {Label: "Read file"}}},
		{Kind: "file", Text: "", Status: "done"},
	}
	canonical := canonicalJSON(typed)
	if got, want := HistorySearchText(typed), HistorySearchText(canonical); got != want {
		t.Fatalf("history text = %q, want %q", got, want)
	}
	key := testKey()
	typedTokens := SearchTokens(key, HistorySearchText(typed), StringsIn(typed))
	canonicalTokens := SearchTokens(key, HistorySearchText(canonical), StringsIn(canonical))
	if !reflect.DeepEqual(typedTokens, canonicalTokens) {
		t.Fatalf("typed tokens = %v, want %v", typedTokens, canonicalTokens)
	}
	if len(typedTokens) == 0 {
		t.Fatal("typed blocks produced no tokens")
	}
}

func TestSealJSONTypedStringSliceKeepsEveryElement(t *testing.T) {
	key, location := testKey(), testLocation()
	seal := func(plaintext string) (string, error) { return EncryptText(key, location, plaintext) }
	open := func(ciphertext string) (string, error) { return DecryptText(key, location, ciphertext) }
	sealed, err := SealJSON([]string{"a", "b"}, nil, seal)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	items, ok := sealed.([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("sealed as %T, want 2 elements", sealed)
	}
	for index, want := range []string{`"a"`, `"b"`} {
		got, err := open(items[index].(map[string]any)[SealedField].(string))
		if err != nil || got != want {
			t.Fatalf("element %d opens as %q, %v; want %s", index, got, err, want)
		}
	}
	opened, err := OpenJSON(sealed, open)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !reflect.DeepEqual(opened, []any{"a", "b"}) {
		t.Fatalf("opened = %#v", opened)
	}
}

func TestSealJSONWritesNonFiniteNumbersAsNull(t *testing.T) {
	identity := func(plaintext string) (string, error) { return plaintext, nil }
	cases := []struct {
		name  string
		value any
		want  string
	}{
		{"overflowing number", map[string]any{"n": json.Number("1e400")}, `{"n":null}`},
		{"negative overflow", map[string]any{"n": json.Number("-1e400")}, `{"n":null}`},
		{"nan number", map[string]any{"n": json.Number("NaN")}, `{"n":null}`},
		{"float non-finite", map[string]any{"a": math.Inf(1), "b": math.NaN(), "c": math.Inf(-1)}, `{"a":null,"b":null,"c":null}`},
		{"nested", map[string]any{"a": []any{json.Number("1e400"), json.Number("1.5")}}, `{"a":[null,1.5]}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			sealed, err := SealJSON(testCase.value, nil, identity)
			if err != nil {
				t.Fatalf("seal: %v", err)
			}
			record, ok := sealed.(map[string]any)
			if !ok {
				t.Fatalf("sealed value is %T", sealed)
			}
			if got := record[SealedField]; got != testCase.want {
				t.Fatalf("sealed plaintext = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestMasterKeyTrimMatchesJavaScript(t *testing.T) {
	hexKey := strings.Repeat("ab", 32)
	parse := func(entry string) ([]MasterKey, error) {
		return MasterKeysFromEnv(func(name string) string {
			switch name {
			case "ENCRYPTION_KEY":
				return "test-encryption-key-0123456789abcdef"
			case "ENCRYPTION_MASTER_KEYS":
				return entry
			}
			return ""
		})
	}
	// String.prototype.trim strips U+FEFF (and the Zs spaces) but not U+0085.
	accepted := []string{
		"k1:" + "\uFEFF" + hexKey,
		"k1:" + hexKey + "\uFEFF",
		"k1:" + "\u00A0" + hexKey + "\u3000",
		"\uFEFFk1:" + hexKey,
		"k1:" + strings.Repeat("A", 40) + "ŁŃŁĽGTA",
	}
	for _, entry := range accepted {
		keys, err := parse(entry)
		if err != nil {
			t.Fatalf("parse %q: %v", entry, err)
		}
		if entry == accepted[4] {
			if got := hexString(keys[0].Key); got != strings.Repeat("0", 62)+"20" {
				t.Fatalf("non-ASCII material = %s", got)
			}
			continue
		}
		if got := hexString(keys[0].Key); got != hexKey {
			t.Fatalf("parse %q = %s", entry, got)
		}
	}
	// U+0085 is not JS whitespace: a 64-hex key with one attached is 65 runes,
	// takes the base64 branch and decodes to 48 bytes, which must be rejected.
	for _, entry := range []string{"k1:" + hexKey + "\u0085", "k1:" + "\u0085" + hexKey} {
		if _, err := parse(entry); err == nil {
			t.Fatalf("U+0085 must not be trimmed: %q", entry)
		}
	}
}

func TestEncryptionKeyTrimMatchesJavaScript(t *testing.T) {
	getenv := func(key string) func(string) string {
		return func(name string) string {
			if name == "ENCRYPTION_KEY" {
				return key
			}
			return ""
		}
	}
	// U+FEFF is trimmed away, leaving nothing: the key is required.
	if _, err := MasterKeysFromEnv(getenv("\uFEFF")); err == nil {
		t.Fatal("a U+FEFF-only ENCRYPTION_KEY is empty after JS trim")
	}
	// U+0085 is not trimmed, so JS sees a non-empty (odd) key and so must Go.
	keys, err := MasterKeysFromEnv(getenv("\u0085"))
	if err != nil {
		t.Fatalf("U+0085 is not JS whitespace: %v", err)
	}
	if len(keys) != 1 || keys[0].ID != DerivedMasterKeyID {
		t.Fatalf("derived key missing: %#v", keys)
	}
}
