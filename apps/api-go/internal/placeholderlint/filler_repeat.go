package placeholderlint

import "strings"

// FillerRepeat flags a value made of the same ASCII letter repeated three or
// more times, ignoring case: "xxx", "AAA". It matches the whole value only and
// does not touch digits or other punctuation.
type FillerRepeat struct{}

// Name implements Rule.
func (FillerRepeat) Name() string { return "filler-repeat" }

// Check implements Rule.
func (FillerRepeat) Check(argument Argument) bool {
	value := strings.TrimSpace(argument.Value)
	if len(value) < 3 {
		return false
	}
	first := value[0]
	if !isASCIILetter(first) {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if !isASCIILetter(character) || lowerASCII(character) != lowerASCII(first) {
			return false
		}
	}
	return true
}

func isASCIILetter(character byte) bool {
	return character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z'
}

func lowerASCII(character byte) byte {
	if character >= 'A' && character <= 'Z' {
		return character + ('a' - 'A')
	}
	return character
}
