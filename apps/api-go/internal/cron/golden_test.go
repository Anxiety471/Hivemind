package cron

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// The golden file is recorded from nextCronDate/nextCronDateAcross by
// tools/cron-golden.mts: syntax features, DST gaps and overlaps, calendar
// edges, timezone names and multi-cron earliest selection.
type goldenCase struct {
	Name     string   `json:"name"`
	Crons    []string `json:"crons"`
	From     string   `json:"from"`
	Timezone string   `json:"timezone"`
	Want     *string  `json:"want"`
}

func isoOf(at time.Time, ok bool) *string {
	if !ok {
		return nil
	}
	value := at.UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

func sameInstant(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func TestNextCronDateMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("testdata/cron_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 300 {
		t.Fatalf("golden file has %d cases, want at least 300", len(cases))
	}
	failures := 0
	for _, testCase := range cases {
		from, err := time.Parse(time.RFC3339Nano, testCase.From)
		if err != nil {
			t.Fatalf("%s: from %q: %v", testCase.Name, testCase.From, err)
		}
		across, ok := NextCronDateAcross(testCase.Crons, from, testCase.Timezone)
		if got := isoOf(across, ok); !sameInstant(got, testCase.Want) {
			failures++
			if failures <= 20 {
				t.Errorf("%s %v from %s %s: got %v want %v", testCase.Name, testCase.Crons,
					testCase.From, testCase.Timezone, show(got), show(testCase.Want))
			}
			continue
		}
		if len(testCase.Crons) != 1 {
			continue
		}
		single, singleOK := NextCronDate(testCase.Crons[0], from, testCase.Timezone)
		if got := isoOf(single, singleOK); !sameInstant(got, testCase.Want) {
			failures++
			if failures <= 20 {
				t.Errorf("%s single %v from %s %s: got %v want %v", testCase.Name, testCase.Crons,
					testCase.From, testCase.Timezone, show(got), show(testCase.Want))
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d cases differ", failures, len(cases))
	}
	t.Logf("%d cases match", len(cases))
}

func show(value *string) string {
	if value == nil {
		return "null"
	}
	return *value
}

func TestOneShotRecognition(t *testing.T) {
	if !IsOneShotRoutineCron(" @once ") || !IsOneShotRoutineCron("@once") {
		t.Fatal("@once is the one-shot schedule")
	}
	if IsOneShotRoutineCron("@daily") {
		t.Fatal("@daily is not one-shot")
	}
	if !IsOneShotRoutineCrons([]string{"@once"}) {
		t.Fatal("a single @once is a one-shot routine")
	}
	if IsOneShotRoutineCrons([]string{"@once", "0 0 * * *"}) || IsOneShotRoutineCrons(nil) {
		t.Fatal("a mixed or empty list is not one-shot")
	}
}
