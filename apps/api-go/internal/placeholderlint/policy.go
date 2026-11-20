package placeholderlint

import "slices"

// Policy customizes linting for tool calls. Its zero value applies the default
// rules with no exemptions.
type Policy struct {
	// DisabledTools names tools whose arguments are never linted.
	DisabledTools []string
	// ExemptArgs maps a tool name to argument names or dotted paths that are
	// never linted. An entry matches both the argument's own name ("query")
	// and its full path ("request.query").
	ExemptArgs map[string][]string
}

// KnownValues lists values that are legitimate for an argument, normally the
// enum or const values of the tool's JSON schema. The key is an argument name
// ("mode") or a dotted path ("config.mode"); an exact path key takes
// precedence over a name key. Argument values in the matching set are never
// linted.
type KnownValues map[string][]string

// Option configures one Lint call. Later options replace earlier ones.
type Option func(*settings)

type settings struct {
	policy          Policy
	known           KnownValues
	requiredContent []string
}

// WithPolicy applies a per-tool policy.
func WithPolicy(policy Policy) Option {
	return func(config *settings) { config.policy = policy }
}

// WithKnownValues exempts argument values the caller's schema already knows
// are legitimate, such as enum and const values.
func WithKnownValues(values KnownValues) Option {
	return func(config *settings) { config.known = values }
}

// WithRequiredContent designates argument names or dotted paths that carry
// required content. A blank string in such an argument is reported by the
// blank-required rule. Optional fields a model leaves empty are not reported
// while the rule has no designation to work with.
func WithRequiredContent(arguments ...string) Option {
	designated := append([]string(nil), arguments...)
	return func(config *settings) { config.requiredContent = designated }
}

func (p Policy) disables(tool string) bool {
	return slices.Contains(p.DisabledTools, tool)
}

func (p Policy) exempts(tool, path, name string) bool {
	return matchesArgument(p.ExemptArgs[tool], path, name)
}

func (k KnownValues) contains(path, name, value string) bool {
	if values, ok := k[path]; ok {
		return slices.Contains(values, value)
	}
	if values, ok := k[name]; ok {
		return slices.Contains(values, value)
	}
	return false
}

func (s *settings) requires(path, name string) bool {
	return matchesArgument(s.requiredContent, path, name)
}

// matchesArgument reports whether an argument name or dotted path appears in
// a caller-supplied list.
func matchesArgument(candidates []string, path, name string) bool {
	return slices.Contains(candidates, path) || slices.Contains(candidates, name)
}
