package shared

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// NormalizeEmail is normalizeEmail (packages/db/src/organization-members.ts): trim, then
// String.prototype.toLowerCase, which is the full, locale-independent Unicode mapping with
// final-sigma handling (x/text's root-language Lower, not strings.ToLower's simple one).
// Known difference: U+0345 directly before a capital sigma lower-cases to a final sigma here
// and to a medial one in JavaScript; no real address has that sequence.
func NormalizeEmail(email string) string {
	return cases.Lower(language.Und).String(validate.JSTrim(email))
}
