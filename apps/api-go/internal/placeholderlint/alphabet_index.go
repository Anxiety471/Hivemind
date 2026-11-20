package placeholderlint

import "strings"

// AlphabetIndex flags the stub a model emits when it does not know what to
// fill in: one uppercase ASCII letter ("A") or an uppercase letter followed by
// one or two digits ("A1", "C2"). Lowercase single letters are left alone
// because they are often real words, such as "a" or "i".
type AlphabetIndex struct{}

// Name implements Rule.
func (AlphabetIndex) Name() string { return "alphabet-index" }

// Check implements Rule.
func (AlphabetIndex) Check(argument Argument) bool {
	value := strings.TrimSpace(argument.Value)
	if len(value) == 0 || value[0] < 'A' || value[0] > 'Z' {
		return false
	}
	digits := value[1:]
	if len(digits) == 0 {
		return true
	}
	if len(digits) > 2 {
		return false
	}
	for index := range len(digits) {
		if digits[index] < '0' || digits[index] > '9' {
			return false
		}
	}
	return true
}
