package shared

import (
	"regexp"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var (
	letterOrNumber = regexp.MustCompile(`[\p{L}\p{N}]`)
	uuidName       = regexp.MustCompile(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
	dunderName     = regexp.MustCompile(`^__[A-Za-z0-9_-]+__$`)
	cuidName       = regexp.MustCompile(`^c[a-z0-9]{24}$`)
	cuid2Name      = regexp.MustCompile(`^[a-z][a-z0-9]{23}$`)
	digit          = regexp.MustCompile(`[0-9]`)
	longName       = regexp.MustCompile(`^[A-Za-z0-9_-]{20,}$`)
	lower          = regexp.MustCompile(`[a-z]`)
	upper          = regexp.MustCompile(`[A-Z]`)
	lettersDigits  = regexp.MustCompile(`^[A-Za-z_-]+[0-9]+$`)
	camelName      = regexp.MustCompile(`^[A-Za-z][a-z]*(?:[A-Z][a-z]+|[0-9]|[_-][A-Za-z][a-z]+)*$`)
)

// IsOpaqueName is isOpaqueName in packages/core/src/display-name.ts.
func IsOpaqueName(name string) bool {
	return dunderName.MatchString(name) || uuidName.MatchString(name) ||
		(cuidName.MatchString(name) && digit.MatchString(name)) ||
		(cuid2Name.MatchString(name) && digit.MatchString(name)) ||
		(longName.MatchString(name) && lower.MatchString(name) && upper.MatchString(name) && digit.MatchString(name) &&
			!lettersDigits.MatchString(name) && !camelName.MatchString(name))
}

// DisplayName is displayName in packages/core/src/display-name.ts: the trimmed name,
// or fallback when it is missing, has no letter or digit, or is an opaque id.
func DisplayName(name *string, fallback string) string {
	if name == nil {
		return fallback
	}
	trimmed := validate.JSTrim(*name)
	if trimmed != "" && letterOrNumber.MatchString(trimmed) && !IsOpaqueName(trimmed) {
		return trimmed
	}
	return fallback
}

// UTF16Length is String.prototype.length: UTF-16 code units, so an astral character counts twice.
func UTF16Length(text string) int {
	count := 0
	for _, character := range text {
		count++
		if character > 0xFFFF {
			count++
		}
	}
	return count
}
