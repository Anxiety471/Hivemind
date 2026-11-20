package placeholderlint

import "testing"

func TestAlphabetIndex(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "single a", value: "A", want: true},
		{name: "single z", value: "Z", want: true},
		{name: "single capital i", value: "I", want: true},
		{name: "letter one digit", value: "B1", want: true},
		{name: "letter two digits", value: "C2", want: true},
		{name: "two digit index", value: "Z99", want: true},
		{name: "padded", value: " Z9 ", want: true},

		{name: "lowercase a", value: "a", want: false},
		{name: "lowercase i", value: "i", want: false},
		{name: "lowercase z", value: "z", want: false},
		{name: "two letters", value: "AA", want: false},
		{name: "mixed letters", value: "AB", want: false},
		{name: "two letters and digit", value: "AB1", want: false},
		{name: "three digits", value: "A100", want: false},
		{name: "separated index", value: "A-1", want: false},
		{name: "trailing letter", value: "A1B", want: false},
		{name: "leading digit", value: "1A", want: false},
		{name: "inner space", value: "A 1", want: false},
		{name: "accented letter", value: "é", want: false},
		{name: "cyrillic letter", value: "К", want: false},
		{name: "word", value: "hello", want: false},
		{name: "empty", value: "", want: false},
		{name: "spaces", value: "   ", want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := (AlphabetIndex{}).Check(Argument{Path: "field", Name: "field", Value: testCase.value})
			if got != testCase.want {
				t.Fatalf("AlphabetIndex.Check(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}
