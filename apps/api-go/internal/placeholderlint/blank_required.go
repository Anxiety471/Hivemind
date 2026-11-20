package placeholderlint

import "strings"

// BlankRequired flags an empty or whitespace-only string in an argument the
// caller designated as required content with WithRequiredContent. It never
// fires for arguments without that designation, so optional fields that a
// model leaves empty or null stay quiet by default.
type BlankRequired struct{}

// Name implements Rule.
func (BlankRequired) Name() string { return "blank-required" }

// Check implements Rule.
func (BlankRequired) Check(argument Argument) bool {
	return argument.RequiredContent && strings.TrimSpace(argument.Value) == ""
}
