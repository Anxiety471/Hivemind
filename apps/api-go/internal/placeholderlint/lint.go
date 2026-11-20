package placeholderlint

import (
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// Lint walks the string values in args, including nested maps and slices, and
// returns one Finding per argument path whose first matching rule flags it.
// Findings are sorted by path, so repeated calls with the same input produce
// identical results.
//
// Non-string leaves, nil values, empty strings without a matching rule, and
// values exempted by the policy or known-value options are skipped. Lint never
// panics on any args shape.
func (l *Linter) Lint(toolName string, args map[string]any, opts ...Option) []Finding {
	var config settings
	for _, option := range opts {
		if option != nil {
			option(&config)
		}
	}
	if config.policy.disables(toolName) {
		return nil
	}

	walker := walker{
		linter:   l,
		config:   &config,
		tool:     toolName,
		inPath:   make(map[uintptr]bool),
		findings: nil,
	}
	walker.walkMap("", args)
	slices.SortFunc(walker.findings, func(a, b Finding) int {
		return strings.Compare(a.Path, b.Path)
	})
	return walker.findings
}

type walker struct {
	linter   *Linter
	config   *settings
	tool     string
	findings []Finding
	// inPath holds pointers to maps and slices on the current traversal path.
	// JSON cannot produce a cycle, but hand-built arguments can, and a cycle
	// must not recurse forever.
	inPath map[uintptr]bool
}

func (w *walker) walk(prefix string, value any) {
	switch typed := value.(type) {
	case map[string]any:
		w.walkMap(prefix, typed)
	case []any:
		w.walkSlice(prefix, typed)
	case map[string]string:
		for key, item := range typed {
			w.check(joinPath(prefix, key), item)
		}
	case []string:
		for index, item := range typed {
			w.check(joinPath(prefix, strconv.Itoa(index)), item)
		}
	case string:
		w.check(prefix, typed)
	}
}

func (w *walker) walkMap(prefix string, object map[string]any) {
	if object == nil {
		return
	}
	pointer := reflect.ValueOf(object).Pointer()
	if !w.enter(pointer) {
		return
	}
	defer w.leave(pointer)

	for key, value := range object {
		w.walk(joinPath(prefix, key), value)
	}
}

func (w *walker) walkSlice(prefix string, values []any) {
	if values == nil {
		return
	}
	pointer := reflect.ValueOf(values).Pointer()
	if !w.enter(pointer) {
		return
	}
	defer w.leave(pointer)

	for index, value := range values {
		w.walk(joinPath(prefix, strconv.Itoa(index)), value)
	}
}

func (w *walker) enter(pointer uintptr) bool {
	if pointer == 0 {
		return true
	}
	if w.inPath[pointer] {
		return false
	}
	w.inPath[pointer] = true
	return true
}

func (w *walker) leave(pointer uintptr) {
	if pointer != 0 {
		delete(w.inPath, pointer)
	}
}

func (w *walker) check(path, value string) {
	name := leafName(path)
	if w.config.policy.exempts(w.tool, path, name) {
		return
	}
	if w.config.known.contains(path, name, value) {
		return
	}

	argument := Argument{
		Tool:            w.tool,
		Path:            path,
		Name:            name,
		Value:           value,
		RequiredContent: w.config.requires(path, name),
	}
	for _, rule := range w.linter.rules {
		if rule.Check(argument) {
			w.findings = append(w.findings, Finding{
				Path:  path,
				Value: value,
				Rule:  rule.Name(),
			})
			return
		}
	}
}

func joinPath(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

func leafName(path string) string {
	if index := strings.LastIndexByte(path, '.'); index >= 0 {
		return path[index+1:]
	}
	return path
}
