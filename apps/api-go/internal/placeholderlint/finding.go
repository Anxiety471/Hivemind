package placeholderlint

import "fmt"

// feedbackValueLimit is the maximum number of characters of the offending
// value shown in a model-facing message.
const feedbackValueLimit = 40

// Finding is one argument that a rule flagged.
type Finding struct {
	// Path is the escaped path of the argument, such as "config.host" or
	// "hosts[0]". See Argument.Path for the escaping rules.
	Path string
	// Value is the full offending value, not truncated.
	Value string
	// Rule is the name of the rule that matched.
	Rule string
}

// Message is the stable, model-facing feedback line for this finding. Long
// values are truncated to feedbackValueLimit characters, including the
// trailing ellipsis. The path is unescaped for display; Finding.Path keeps the
// canonical encoded form.
func (f Finding) Message() string {
	return fmt.Sprintf(
		"argument %q looks like a placeholder (%q); provide the actual value, or ask the user if it's unknown",
		displayPath(f.Path),
		truncateValue(f.Value),
	)
}

func displayPath(path string) string {
	return unescapeKey(path)
}

func truncateValue(value string) string {
	runes := []rune(value)
	if len(runes) <= feedbackValueLimit {
		return value
	}
	return string(runes[:feedbackValueLimit-3]) + "..."
}
