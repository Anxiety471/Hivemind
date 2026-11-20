package placeholderlint

import (
	"fmt"
	"strings"
	"testing"
)

func TestFindingMessageDisplaysUnescapedPath(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		path     string
		wantPath string
	}{
		{name: "plain", path: "config.host", wantPath: "config.host"},
		{name: "dotted key", path: `a\.b`, wantPath: "a.b"},
		{name: "bracket key", path: `hosts\[0\]`, wantPath: "hosts[0]"},
		{name: "array element", path: "hosts[0]", wantPath: "hosts[0]"},
		{name: "bracket key under array", path: `cfg.arr[0].x\]`, wantPath: "cfg.arr[0].x]"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			finding := Finding{Path: testCase.path, Value: "TODO", Rule: "placeholder-word"}
			want := fmt.Sprintf(
				`argument %q looks like a placeholder ("TODO"); provide the actual value, or ask the user if it's unknown`,
				testCase.wantPath,
			)
			if got := finding.Message(); got != want {
				t.Fatalf("Message() = %q, want %q", got, want)
			}
			if finding.Path != testCase.path {
				t.Fatalf("Finding.Path = %q, want the raw encoded %q", finding.Path, testCase.path)
			}
		})
	}
}

func TestFindingMessageTruncatesLongValues(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value string
		want  string
	}{
		{
			name:  "at the limit",
			value: strings.Repeat("z", 40),
			want:  strings.Repeat("z", 40),
		},
		{
			name:  "one over the limit",
			value: strings.Repeat("z", 41),
			want:  strings.Repeat("z", 37) + "...",
		},
		{
			name:  "long value",
			value: strings.Repeat("z", 60),
			want:  strings.Repeat("z", 37) + "...",
		},
		{
			name:  "unicode is counted in characters",
			value: strings.Repeat("é", 50),
			want:  strings.Repeat("é", 37) + "...",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			finding := Finding{Path: "field", Value: testCase.value, Rule: "test"}
			want := "argument \"field\" looks like a placeholder (\"" + testCase.want +
				"\"); provide the actual value, or ask the user if it's unknown"
			if got := finding.Message(); got != want {
				t.Fatalf("Message() = %q, want %q", got, want)
			}
		})
	}
}
