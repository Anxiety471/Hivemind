package placeholderlint

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDefaultRuleNames(t *testing.T) {
	t.Parallel()

	names := make([]string, 0, len(DefaultRules()))
	for _, rule := range DefaultRules() {
		names = append(names, rule.Name())
	}
	want := []string{"blank-required", "template-token", "placeholder-word", "alphabet-index", "filler-repeat"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("DefaultRules() names = %v, want %v", names, want)
	}
}

func TestLintFindsNestedStringValues(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"name": "TODO",
		"config": map[string]any{
			"host":  "B",
			"port":  8080,
			"tags":  []any{"xxx", "real", "A1"},
			"empty": "",
			"note":  nil,
		},
		"labels":   []string{"real", "dummy"},
		"metadata": map[string]string{"owner": "B2"},
		"enabled":  true,
		"count":    2,
	}

	got := New(DefaultRules()...).Lint("demo", args)
	want := []Finding{
		{Path: "config.host", Value: "B", Rule: "alphabet-index"},
		{Path: "config.tags.0", Value: "xxx", Rule: "filler-repeat"},
		{Path: "config.tags.2", Value: "A1", Rule: "alphabet-index"},
		{Path: "labels.1", Value: "dummy", Rule: "placeholder-word"},
		{Path: "metadata.owner", Value: "B2", Rule: "alphabet-index"},
		{Path: "name", Value: "TODO", Rule: "placeholder-word"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() = %#v, want %#v", got, want)
	}
}

func TestLintIsDeterministic(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"alpha": "TODO",
		"beta":  "xxx",
		"gamma": map[string]any{"a": "A", "b": "B1", "c": "ok"},
		"delta": []any{"<name>", "plain", "${value}"},
	}
	linter := New(DefaultRules()...)

	first := findingLines(linter.Lint("demo", args))
	for iteration := range 100 {
		got := findingLines(linter.Lint("demo", args))
		if !reflect.DeepEqual(got, first) {
			t.Fatalf("Lint() iteration %d = %v, want %v", iteration, got, first)
		}
	}
	for index := 1; index < len(first); index++ {
		if first[index-1] >= first[index] {
			t.Fatalf("findings are not sorted by path: %v", first)
		}
	}
}

func TestLintMessages(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{
			name: "top level",
			args: map[string]any{"host": "B"},
			want: `argument "host" looks like a placeholder ("B"); provide the actual value, or ask the user if it's unknown`,
		},
		{
			name: "nested path",
			args: map[string]any{"config": map[string]any{"host": "A"}},
			want: `argument "config.host" looks like a placeholder ("A"); provide the actual value, or ask the user if it's unknown`,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			findings := New(DefaultRules()...).Lint("demo", testCase.args)
			if len(findings) != 1 {
				t.Fatalf("Lint() returned %d findings, want 1: %#v", len(findings), findings)
			}
			if got := findings[0].Message(); got != testCase.want {
				t.Fatalf("Message() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestLintPolicy(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"query": "TODO",
		"name":  "A",
		"config": map[string]any{
			"host": "B",
			"mode": "C",
		},
	}
	policy := Policy{ExemptArgs: map[string][]string{
		"search": {"query", "config.host", "mode"},
	}}

	got := New(DefaultRules()...).Lint("search", args, WithPolicy(policy))
	want := []Finding{{Path: "name", Value: "A", Rule: "alphabet-index"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() with exemptions = %#v, want %#v", got, want)
	}

	disabled := New(DefaultRules()...).Lint("search", args, WithPolicy(Policy{DisabledTools: []string{"search"}}))
	if len(disabled) != 0 {
		t.Fatalf("Lint() for a disabled tool = %#v, want no findings", disabled)
	}

	otherTool := New(DefaultRules()...).Lint("other", args, WithPolicy(Policy{DisabledTools: []string{"search"}}))
	if len(otherTool) == 0 {
		t.Fatal("Lint() for another tool returned no findings; disabling is not per tool")
	}
}

func TestLintKnownValues(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"mode": "A",
		"host": "B",
		"config": map[string]any{
			"tier": "C",
			"zone": "A",
		},
	}
	known := KnownValues{
		"mode":        {"A"},
		"config.tier": {"C"},
		"zone":        {"A"},
	}

	got := New(DefaultRules()...).Lint("demo", args, WithKnownValues(known))
	want := []Finding{{Path: "host", Value: "B", Rule: "alphabet-index"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() with known values = %#v, want %#v", got, want)
	}
}

func TestLintKnownValuesPathTakesPrecedence(t *testing.T) {
	t.Parallel()

	args := map[string]any{"config": map[string]any{"mode": "A"}}
	known := KnownValues{
		"config.mode": {"Z"},
		"mode":        {"A"},
	}
	got := New(DefaultRules()...).Lint("demo", args, WithKnownValues(known))
	want := []Finding{{Path: "config.mode", Value: "A", Rule: "alphabet-index"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() = %#v, want %#v", got, want)
	}
}

func TestLintRequiredContentAndOptionalBlanks(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"label":   "",
		"purpose": " \t",
		"notes":   map[string]any{"text": " \n "},
		"name":    "A",
	}

	got := New(DefaultRules()...).Lint("request", args, WithRequiredContent("label", "notes.text"))
	want := []Finding{
		{Path: "label", Value: "", Rule: "blank-required"},
		{Path: "name", Value: "A", Rule: "alphabet-index"},
		{Path: "notes.text", Value: " \n ", Rule: "blank-required"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() with required content = %#v, want %#v", got, want)
	}

	withoutDesignation := New(DefaultRules()...).Lint("request", args)
	want = []Finding{{Path: "name", Value: "A", Rule: "alphabet-index"}}
	if !reflect.DeepEqual(withoutDesignation, want) {
		t.Fatalf("Lint() without required content = %#v, want %#v", withoutDesignation, want)
	}
}

func TestLintLeavesOptionalBlanksAlone(t *testing.T) {
	t.Parallel()

	args := map[string]any{
		"before": "",
		"botId":  " ",
		"query":  nil,
	}
	if got := New(DefaultRules()...).Lint("demo", args); len(got) != 0 {
		t.Fatalf("Lint() = %#v, want no findings for optional blanks", got)
	}
}

func TestLintLeavesLegitimateValuesAlone(t *testing.T) {
	t.Parallel()

	values := []string{
		"https://x/a%20b",
		"https://example.com/a%2Fb?q=100%25",
		"user@example.com",
		"a",
		"i",
		"Al",
		"Bo",
		"Jo",
		"你好，世界",
		"😀 project",
		"100% done",
		"a < b and c > d",
		"Use <b>bold</b> text",
		"add a todo list",
		"example.com",
		"plain sentence with real words",
	}

	linter := New(DefaultRules()...)
	for _, value := range values {
		t.Run(value, func(t *testing.T) {
			t.Parallel()
			args := map[string]any{"value": value}
			if got := linter.Lint("demo", args); len(got) != 0 {
				t.Fatalf("Lint(%q) = %#v, want no findings", value, got)
			}
		})
	}
}

func TestLintNilAndEmpty(t *testing.T) {
	t.Parallel()

	linter := New(DefaultRules()...)
	cases := []struct {
		name string
		args map[string]any
	}{
		{name: "nil map", args: nil},
		{name: "empty map", args: map[string]any{}},
		{name: "empty leaves", args: map[string]any{
			"empty":      "",
			"spaces":     "   ",
			"nil map":    map[string]any(nil),
			"nil slice":  []any(nil),
			"nil values": []any{nil},
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := linter.Lint("demo", testCase.args); len(got) != 0 {
				t.Fatalf("Lint() = %#v, want no findings", got)
			}
		})
	}
}

func TestLintIgnoresNonStringValues(t *testing.T) {
	t.Parallel()

	type odd struct{ Value string }
	args := map[string]any{
		"number": 42,
		"float":  1.5,
		"bool":   true,
		"nil":    nil,
		"struct": odd{Value: "TODO"},
		"func":   func() {},
		"chan":   make(chan int),
		"ints":   []int{1, 2},
		"byInt":  map[int]string{1: "TODO"},
	}

	if got := New(DefaultRules()...).Lint("demo", args); len(got) != 0 {
		t.Fatalf("Lint() = %#v, want no findings", got)
	}
}

func TestLintHandlesCycles(t *testing.T) {
	t.Parallel()

	cyclicMap := map[string]any{"name": "TODO"}
	cyclicMap["self"] = cyclicMap

	cyclicSlice := make([]any, 2)
	cyclicSlice[0] = "xxx"
	cyclicSlice[1] = cyclicSlice

	inner := map[string]any{"note": "A"}
	outer := []any{inner}
	inner["list"] = outer

	cases := []struct {
		name string
		args map[string]any
		want []Finding
	}{
		{
			name: "map contains itself",
			args: cyclicMap,
			want: []Finding{{Path: "name", Value: "TODO", Rule: "placeholder-word"}},
		},
		{
			name: "slice contains itself",
			args: map[string]any{"items": cyclicSlice},
			want: []Finding{{Path: "items.0", Value: "xxx", Rule: "filler-repeat"}},
		},
		{
			name: "map and slice cycle",
			args: map[string]any{"root": inner},
			want: []Finding{{Path: "root.note", Value: "A", Rule: "alphabet-index"}},
		},
	}

	linter := New(DefaultRules()...)
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := linter.Lint("demo", testCase.args); !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("Lint() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

type bananaRule struct{}

func (bananaRule) Name() string { return "banana" }

func (bananaRule) Check(argument Argument) bool {
	return argument.Tool == "demo" &&
		argument.Path == "nested.fruit" &&
		argument.Name == "fruit" &&
		strings.Contains(argument.Value, "banana")
}

func TestLintExtensibilityWithCustomRule(t *testing.T) {
	t.Parallel()

	linter := New(DefaultRules()...)
	linter.Register(bananaRule{})
	args := map[string]any{"nested": map[string]any{"fruit": "banana split"}}

	got := linter.Lint("demo", args)
	want := []Finding{{Path: "nested.fruit", Value: "banana split", Rule: "banana"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() with a custom rule = %#v, want %#v", got, want)
	}
}

type constantRule struct {
	name  string
	value string
}

func (r constantRule) Name() string { return r.name }

func (r constantRule) Check(argument Argument) bool { return argument.Value == r.value }

func TestLintFirstMatchingRuleWins(t *testing.T) {
	t.Parallel()

	linter := New(
		constantRule{name: "first", value: "target"},
		constantRule{name: "second", value: "target"},
	)
	got := linter.Lint("demo", map[string]any{"field": "target"})
	want := []Finding{{Path: "field", Value: "target", Rule: "first"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lint() = %#v, want %#v", got, want)
	}
}

func findingLines(findings []Finding) []string {
	lines := make([]string, 0, len(findings))
	for _, finding := range findings {
		lines = append(lines, fmt.Sprintf("%s|%s|%s|%s", finding.Path, finding.Rule, finding.Value, finding.Message()))
	}
	return lines
}
