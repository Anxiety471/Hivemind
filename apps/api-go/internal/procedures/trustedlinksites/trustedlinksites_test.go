package trustedlinksites

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func issueJSON(t *testing.T, failure *orpc.Error) string {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a validation failure")
	}
	if failure.Code != "BAD_REQUEST" || failure.Status != 400 || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	body, err := orpc.Marshal(failure.Data)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestParseRemove(t *testing.T) {
	site, failure := parseRemove(orpc.Input{Raw: json.RawMessage(`{"site":"example.com","extra":1}`)})
	if failure != nil || site != "example.com" {
		t.Fatalf("valid = %q, %v", site, failure)
	}
	// Zod counts code points, so astral characters count once.
	for _, unit := range []string{"a", "😀"} {
		if _, failure := parseRemove(orpc.Input{Raw: json.RawMessage(`{"site":"` + strings.Repeat(unit, 253) + `"}`)}); failure != nil {
			t.Fatalf("253 x %q: %v", unit, failure)
		}
		if _, failure := parseRemove(orpc.Input{Raw: json.RawMessage(`{"site":"` + strings.Repeat(unit, 254) + `"}`)}); failure == nil {
			t.Fatalf("254 x %q should fail", unit)
		}
	}
	cases := map[string]struct {
		raw  string
		want string
	}{
		"none":    {"", `{"issues":[{"code":"invalid_type","expected":"object","message":"Invalid input: expected object, received undefined","path":[]}]}`},
		"null":    {`null`, ``},
		"array":   {`[]`, `{"issues":[{"code":"invalid_type","expected":"object","message":"Invalid input: expected object, received array","path":[]}]}`},
		"missing": {`{}`, `{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received undefined","path":["site"]}]}`},
		"number":  {`{"site":3}`, `{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received number","path":["site"]}]}`},
		"empty":   {`{"site":""}`, `{"issues":[{"code":"too_small","inclusive":true,"message":"Too small: expected string to have >=1 characters","minimum":1,"origin":"string","path":["site"]}]}`},
		"long":    {`{"site":"` + strings.Repeat("a", 254) + `"}`, `{"issues":[{"code":"too_big","inclusive":true,"maximum":253,"message":"Too big: expected string to have <=253 characters","origin":"string","path":["site"]}]}`},
	}
	for name, tc := range cases {
		_, failure := parseRemove(orpc.Input{Raw: json.RawMessage(tc.raw)})
		got := issueJSON(t, failure)
		if tc.want != "" && !jsonEqual(got, tc.want) {
			t.Errorf("%s: got %s want %s", name, got, tc.want)
		}
	}
}

func jsonEqual(a, b string) bool {
	var left, right any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return false
	}
	l, _ := json.Marshal(left)
	r, _ := json.Marshal(right)
	return string(l) == string(r)
}
