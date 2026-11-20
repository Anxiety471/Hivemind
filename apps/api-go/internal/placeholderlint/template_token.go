package placeholderlint

import "strings"

// TemplateToken flags values that are, or contain as a clearly delimited
// token, a template escape: "${...}", "{{...}}", an angle token such as
// "<name>", or a printf token such as "%s", "%d" or "%1".
//
// The check stays conservative around characters that are ordinary in real
// values: percent-encoding in URLs ("%20", "%2F") is not a printf token, and
// comparison prose ("x < y", "5 < 10 > 3") is not an angle token.
type TemplateToken struct{}

// Name implements Rule.
func (TemplateToken) Name() string { return "template-token" }

// Check implements Rule.
func (TemplateToken) Check(argument Argument) bool {
	value := argument.Value
	return containsDollarToken(value) ||
		containsBraceToken(value) ||
		containsAngleToken(value) ||
		containsPrintfToken(value)
}

func containsDollarToken(value string) bool {
	start := strings.Index(value, "${")
	return start >= 0 && strings.Contains(value[start+2:], "}")
}

func containsBraceToken(value string) bool {
	start := strings.Index(value, "{{")
	return start >= 0 && strings.Contains(value[start+2:], "}}")
}

// containsAngleToken scans for "<...>" tokens whose content can be a
// placeholder name. Anything with an attribute, a closing tag, a doctype or
// non-name characters is left alone, as is a token that touches a word
// character on either side.
func containsAngleToken(value string) bool {
	for start := range len(value) {
		if value[start] != '<' {
			continue
		}
		closing := strings.IndexByte(value[start+1:], '>')
		if closing < 0 {
			return false
		}
		end := start + 1 + closing
		if angleTokenContent(value[start+1:end]) && angleDelimited(value, start, end) {
			return true
		}
	}
	return false
}

func angleTokenContent(content string) bool {
	if len(content) == 0 || len(content) > 60 {
		return false
	}
	first := content[0]
	if !(first >= 'A' && first <= 'Z') && !(first >= 'a' && first <= 'z') && first != '_' {
		return false
	}
	hasLetter := false
	for index := range len(content) {
		character := content[index]
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z':
			hasLetter = true
		case character >= '0' && character <= '9',
			character == '_', character == '-', character == '.', character == ' ':
		default:
			return false
		}
	}
	return hasLetter
}

func angleDelimited(value string, start, end int) bool {
	if start > 0 && isWordByte(value[start-1]) {
		return false
	}
	if end+1 < len(value) && isWordByte(value[end+1]) {
		return false
	}
	return true
}

func isWordByte(character byte) bool {
	return character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z' ||
		character >= '0' && character <= '9' ||
		character == '_'
}

// containsPrintfToken looks for "%s", "%d" and "%1" through "%9". A token
// followed by another word character does not count, which keeps words like
// "%done" and positional text alone; two characters after "%2" or "%1" that
// are both hexadecimal digits mean percent-encoding, not printf.
func containsPrintfToken(value string) bool {
	for index := range len(value) - 1 {
		if value[index] != '%' {
			continue
		}
		switch verb := value[index+1]; {
		case verb == 's' || verb == 'd':
			if index+2 >= len(value) || !isWordByte(value[index+2]) {
				return true
			}
		case verb >= '1' && verb <= '9':
			if index+2 >= len(value) || !isHexByte(value[index+2]) {
				return true
			}
		}
	}
	return false
}

func isHexByte(character byte) bool {
	return character >= '0' && character <= '9' ||
		character >= 'a' && character <= 'f' ||
		character >= 'A' && character <= 'F'
}
