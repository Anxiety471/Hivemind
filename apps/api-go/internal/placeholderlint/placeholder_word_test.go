package placeholderlint

import "testing"

func TestPlaceholderWord(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "upper todo", value: "TODO", want: true},
		{name: "lower todo", value: "todo", want: true},
		{name: "spaced todo", value: "To Do", want: true},
		{name: "underscored todo", value: "to_do", want: true},
		{name: "hyphenated todo", value: "to-do", want: true},
		{name: "n slash a upper", value: "N/A", want: true},
		{name: "n slash a spaced", value: "n / a", want: true},
		{name: "lorem ipsum", value: "Lorem Ipsum", want: true},
		{name: "sample upper", value: "SAMPLE", want: true},
		{name: "test value", value: "test_value", want: true},
		{name: "some text", value: "SomeText", want: true},
		{name: "padded fixme", value: " FIXME ", want: true},
		{name: "unknown", value: "UNKNOWN", want: true},
		{name: "unspecified", value: "unspecified", want: true},
		{name: "placeholder", value: "placeholder", want: true},
		{name: "dummy", value: "dummy", want: true},
		{name: "example", value: "example", want: true},
		{name: "tbd", value: "tbd", want: true},
		{name: "lorem", value: "lorem", want: true},

		{name: "empty", value: "", want: false},
		{name: "spaces", value: "   ", want: false},
		{name: "plural", value: "todos", want: false},
		{name: "inside prose", value: "my todo", want: false},
		{name: "domain", value: "example.com", want: false},
		{name: "unknown user", value: "unknownuser", want: false},
		{name: "short test", value: "test", want: false},
		{name: "unmatched n a", value: "n a", want: false},
		{name: "long lorem", value: "lorem ipsum dolor", want: false},
		{name: "numbered value", value: "TESTVALUE2", want: false},
		{name: "compound word", value: "dummy_value", want: false},
		{name: "sample text", value: "sample text", want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := (PlaceholderWord{}).Check(Argument{Path: "field", Name: "field", Value: testCase.value})
			if got != testCase.want {
				t.Fatalf("PlaceholderWord.Check(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}
