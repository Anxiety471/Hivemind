package shared

import (
	"encoding/json"
	"os"
	"testing"
)

func TestNormalizeEmailLowercasesLikeJavaScript(t *testing.T) {
	var rows [][2]string
	body, err := os.ReadFile("testdata/lowercase.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if got := NormalizeEmail("  " + row[0] + "\t"); got != row[1] {
			t.Errorf("NormalizeEmail(%q) = %q, want %q", row[0], got, row[1])
		}
	}
}
