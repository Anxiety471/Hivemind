package contentcrypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"regexp"
	"sort"
	"unicode/utf16"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// Blind-index search over encrypted messages (content-crypto.ts:151-201):
// keyed HMACs of normalized words and word prefixes, truncated to 32 bits.
// Equality and frequency within a Space are visible to a database reader, the
// words are not; a collision only costs a candidate the caller filters after
// decryption.
const (
	maxPrefix = 10
	minPrefix = 2
	// searchInfo is the HKDF info of the per-space search key.
	searchInfo = "rakazo/search/v1"
)

// SearchTokenDomain is the domain separator a token is keyed under.
type SearchTokenDomain string

// The two domains; the same word in both domains yields different tokens.
const (
	DomainWord   SearchTokenDomain = "word"
	DomainPrefix SearchTokenDomain = "prefix"
)

var (
	searchTermPattern = regexp.MustCompile(`[\p{L}\p{N}]+`)
	// searchLower is the Unicode default lowercase mapping, including the
	// SpecialCasing entries JavaScript applies (İ → i + combining dot, final
	// sigma). strings.ToLower uses the simple mapping and would diverge.
	searchLower = cases.Lower(language.Und)
)

// SearchKey derives the per-space search key: HKDF-SHA256 with an empty salt
// and info "rakazo/search/v1" (content-crypto.ts:159-161).
func SearchKey(key DataKey) []byte {
	return hkdfSHA256(key.Key, nil, []byte(searchInfo), 32)
}

// SearchTerms is searchTerms (content-crypto.ts:163-172): NFKC normalization,
// lowercase, then runs of letters and numbers, deduplicated in first-seen order.
func SearchTerms(text string) []string {
	lowered := searchLower.String(norm.NFKC.String(text))
	matches := searchTermPattern.FindAllString(lowered, -1)
	seen := make(map[string]bool, len(matches))
	terms := matches[:0]
	for _, match := range matches {
		if seen[match] {
			continue
		}
		seen[match] = true
		terms = append(terms, match)
	}
	return terms
}

// token is content-crypto.ts:174-176: HMAC-SHA256 over "<domain>\0<term>", and
// the first four bytes read as a signed big-endian int32.
func token(hmacKey []byte, domain SearchTokenDomain, term string) int32 {
	mac := hmac.New(sha256.New, hmacKey)
	mac.Write([]byte(string(domain) + "\x00" + term))
	sum := mac.Sum(nil)
	return int32(binary.BigEndian.Uint32(sum[:4]))
}

// SearchTokens is searchTokens (content-crypto.ts:179-187): word tokens for
// the conversational text, prefix tokens (2 to 10 code units) for every string
// in the value. Sorted numerically, as the TS Set is.
func SearchTokens(key DataKey, words string, strings []string) []int32 {
	hmacKey := SearchKey(key)
	seen := make(map[int32]bool)
	var tokens []int32
	add := func(token int32) {
		if seen[token] {
			return
		}
		seen[token] = true
		tokens = append(tokens, token)
	}
	for _, term := range SearchTerms(words) {
		add(token(hmacKey, DomainWord, term))
	}
	joined := ""
	for index, value := range strings {
		if index > 0 {
			joined += "\n"
		}
		joined += value
	}
	for _, term := range SearchTerms(joined) {
		units := wtf8.Units(term)
		limit := len(units)
		if limit > maxPrefix {
			limit = maxPrefix
		}
		for length := minPrefix; length <= limit; length++ {
			add(token(hmacKey, DomainPrefix, prefix(units, length)))
		}
	}
	sort.Slice(tokens, func(a, b int) bool { return tokens[a] < tokens[b] })
	return tokens
}

// prefix is `term.slice(0, length)` in UTF-16 code units. A slice that splits
// a surrogate pair decodes to U+FFFD, the same replacement Node writes to
// UTF-8, so even that prefix token matches.
func prefix(units []uint16, length int) string {
	return string(utf16.Decode(units[:length]))
}

// QuerySearchTokens is querySearchTokens (content-crypto.ts:193-201): the
// tokens every match must contain. Prefix queries use each term's indexed
// prefix, and terms shorter than the minimum prefix return none.
func QuerySearchTokens(key DataKey, query string, domain SearchTokenDomain) []int32 {
	hmacKey := SearchKey(key)
	terms := SearchTerms(query)
	if domain == DomainWord {
		tokens := make([]int32, 0, len(terms))
		for _, term := range terms {
			tokens = append(tokens, token(hmacKey, DomainWord, term))
		}
		return tokens
	}
	tokens := make([]int32, 0, len(terms))
	for _, term := range terms {
		units := wtf8.Units(term)
		if len(units) < minPrefix {
			continue
		}
		length := len(units)
		if length > maxPrefix {
			length = maxPrefix
		}
		tokens = append(tokens, token(hmacKey, DomainPrefix, prefix(units, length)))
	}
	return tokens
}
