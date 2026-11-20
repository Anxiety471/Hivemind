// Package placeholderlint detects tool-call argument values that look like
// placeholders rather than real values: template escapes, filler words,
// alphabet-index stubs and repeated filler letters.
//
// The package is a pure, deterministic library with no I/O and no global
// mutable state. A Linter is an ordered list of rules; Lint walks one tool
// call's arguments and returns at most one Finding per string argument path.
//
// Rules depend only on the tool name, the argument path and value, and
// caller-supplied metadata. They never hardcode knowledge of a particular
// tool: optional fields, enum values and required-content arguments are all
// described by the caller through Options.
package placeholderlint

// Argument is one string argument value presented to a Rule.
type Argument struct {
	// Tool is the tool name passed to Lint.
	Tool string
	// Path is the dotted path from the tool call's arguments to this value,
	// such as "name" or "config.host". Array elements use their index as a
	// path segment, such as "hosts.0".
	Path string
	// Name is the last segment of Path: the argument's own name.
	Name string
	// Value is the string leaf being checked.
	Value string
	// RequiredContent reports whether the caller designated this argument as
	// required content. Rules that only make sense for required fields, such
	// as blank-required, stay silent when it is false.
	RequiredContent bool
}

// Rule is a named check over one string argument value at a dotted path.
// Rules are stateless and self-contained: each default rule lives in its own
// type, and adding a rule means adding a type and listing it in DefaultRules.
type Rule interface {
	// Name is the rule's stable identifier, used in Findings and messages.
	Name() string
	// Check reports whether the argument looks like a placeholder.
	Check(argument Argument) bool
}

// Linter holds an ordered rule slice. The first rule that matches an argument
// produces that argument's only finding. Register appends a rule, and Lint is
// safe for concurrent use as long as no rule is registered concurrently.
type Linter struct {
	rules []Rule
}

// New returns a Linter with the given rules in order. A nil rules slice gives
// a Linter that reports nothing until Register is called.
func New(rules ...Rule) *Linter {
	return &Linter{rules: append([]Rule(nil), rules...)}
}

// Register appends a rule after the linter's existing rules.
func (l *Linter) Register(rule Rule) {
	l.rules = append(l.rules, rule)
}

// DefaultRules returns a new slice with the built-in rules in order. This is
// the one place a new default rule is listed; callers compose custom rule sets
// from it.
func DefaultRules() []Rule {
	return []Rule{
		BlankRequired{},
		TemplateToken{},
		PlaceholderWord{},
		AlphabetIndex{},
		FillerRepeat{},
	}
}
