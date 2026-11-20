package placeholderlint

import "testing"

func TestFillerRepeat(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "lower x", value: "xxx", want: true},
		{name: "upper a", value: "AAA", want: true},
		{name: "mixed case", value: "xXx", want: true},
		{name: "four letters", value: "aaaa", want: true},
		{name: "five letters", value: "AAAAA", want: true},
		{name: "padded", value: "xxx ", want: true},

		{name: "two letters", value: "xx", want: false},
		{name: "two of three", value: "xxa", want: false},
		{name: "letters and digit", value: "xxx1", want: false},
		{name: "separated", value: "x x x", want: false},
		{name: "different letters", value: "abc", want: false},
		{name: "zeros", value: "000", want: false},
		{name: "ones", value: "111", want: false},
		{name: "emoji", value: "💩💩💩", want: false},
		{name: "accented letters", value: "üüü", want: false},
		{name: "empty", value: "", want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := (FillerRepeat{}).Check(Argument{Path: "field", Name: "field", Value: testCase.value})
			if got != testCase.want {
				t.Fatalf("FillerRepeat.Check(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}
