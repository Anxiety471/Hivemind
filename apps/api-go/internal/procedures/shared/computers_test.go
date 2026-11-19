package shared

import "testing"

func TestMaxComputersPerUserMatchesResolveMaxComputersPerUser(t *testing.T) {
	cases := []struct {
		value string
		limit int
		fails bool
	}{
		{"", 0, false},
		{"   ", 0, false},
		{"0", 0, false},
		{" 2 ", 2, false},
		{"1", 1, false},
		{"1e3", 1000, false},
		{"2.5", 0, true},
		{"-1", 0, true},
		{"00", 0, true},
		{"abc", 0, true},
		{"Infinity", 0, true},
		{"9007199254740992", 0, true},
	}
	for _, testCase := range cases {
		limit, err := MaxComputersPerUser(testCase.value)
		if testCase.fails {
			if err == nil {
				t.Errorf("%q = %d, want a failure", testCase.value, limit)
			}
			continue
		}
		if err != nil || limit != testCase.limit {
			t.Errorf("%q = %d, %v; want %d", testCase.value, limit, err, testCase.limit)
		}
	}
}
