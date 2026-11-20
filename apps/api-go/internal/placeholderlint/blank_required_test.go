package placeholderlint

import "testing"

func TestBlankRequired(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		value    string
		required bool
		want     bool
	}{
		{name: "required empty", value: "", required: true, want: true},
		{name: "required space", value: " ", required: true, want: true},
		{name: "required whitespace", value: "\t\n", required: true, want: true},
		{name: "required padded blank", value: " \t ", required: true, want: true},
		{name: "required value", value: "Report", required: true, want: false},
		{name: "required padded value", value: " Report ", required: true, want: false},

		{name: "optional empty", value: "", required: false, want: false},
		{name: "optional whitespace", value: "  ", required: false, want: false},
		{name: "optional value", value: "Report", required: false, want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := (BlankRequired{}).Check(Argument{
				Path:            "field",
				Name:            "field",
				Value:           testCase.value,
				RequiredContent: testCase.required,
			})
			if got != testCase.want {
				t.Fatalf("BlankRequired.Check(%q, required=%v) = %v, want %v", testCase.value, testCase.required, got, testCase.want)
			}
		})
	}
}
