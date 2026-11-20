package placeholderlint

import "strings"

// placeholderWords is the whole placeholder-word vocabulary. Add words here;
// each is compared with the same normalization as the argument value, so
// "lorem ipsum" in this list matches "lorem_ipsum" in an argument.
var placeholderWords = []string{
	"placeholder",
	"dummy",
	"sample",
	"example",
	"todo",
	"fixme",
	"tbd",
	"n/a",
	"unknown",
	"unspecified",
	"lorem",
	"loremipsum",
	"testvalue",
	"sometext",
}

// PlaceholderWord flags a value whose trimmed, case-folded form, ignoring
// spaces, underscores and hyphens, is a known filler word. It matches the
// whole value only, never a word inside a longer sentence.
type PlaceholderWord struct{}

// Name implements Rule.
func (PlaceholderWord) Name() string { return "placeholder-word" }

// Check implements Rule.
func (PlaceholderWord) Check(argument Argument) bool {
	normalized := normalizeWord(argument.Value)
	if normalized == "" {
		return false
	}
	for _, word := range placeholderWords {
		if normalized == normalizeWord(word) {
			return true
		}
	}
	return false
}

func normalizeWord(value string) string {
	var normalized strings.Builder
	normalized.Grow(len(value))
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		switch character {
		case ' ', '_', '-':
		default:
			normalized.WriteRune(character)
		}
	}
	return normalized.String()
}
