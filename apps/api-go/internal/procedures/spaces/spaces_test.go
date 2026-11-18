package spaces

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestNormalizeNameIsReadableAndSixtyUTF16Units(t *testing.T) {
	cases := []struct {
		name string
		want string
		ok   bool
	}{
		{"  Team  ", "Team", true},
		{strings.Repeat("x", 60), strings.Repeat("x", 60), true},
		{strings.Repeat("x", 61), "", false},
		// Emoji alone are not readable (no letter or digit). Beside letters each is two UTF-16
		// units: zod counts code points (so 30 emoji and "a" pass it), the handler counts units.
		{strings.Repeat("😀", 5), "", false},
		{"a" + strings.Repeat("😀", 29) + "b", "a" + strings.Repeat("😀", 29) + "b", true},
		{"a" + strings.Repeat("😀", 30), "", false},
		{"---", "", false},
		{"__token__", "", false},
		{"123e4567-e89b-12d3-a456-426614174000", "", false},
		{"Q3 plans", "Q3 plans", true},
	}
	for _, c := range cases {
		got, err := normalizeName(c.name)
		if (err == nil) != c.ok || got != c.want {
			t.Errorf("normalizeName(%q) = %q, %v; want %q ok=%t", c.name, got, err, c.want, c.ok)
		}
		if err != nil && err != errInvalidName {
			t.Errorf("normalizeName(%q) = %v", c.name, err)
		}
	}
}

func TestParseRenameReportsEveryIssueInSchemaOrder(t *testing.T) {
	_, failure := parseRename(input(`{"spaceId":"","name":""}`))
	if failure == nil || failure.Code != "BAD_REQUEST" || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	body, _ := orpc.Marshal(failure.Data)
	if !strings.HasPrefix(string(body), `{"issues":[{"code":"too_small","inclusive":true,"message":"Too small: expected string to have >=1 characters","minimum":1,"origin":"string","path":["spaceId"]}`) ||
		!strings.Contains(string(body), `"path":["name"]`) {
		t.Fatalf("issues = %s", body)
	}
	parsed, failure := parseRename(input(`{"spaceId":"a","name":"  Padded  ","more":1}`))
	if failure != nil || parsed.SpaceID != "a" || parsed.Name != "Padded" {
		t.Fatalf("parsed = %+v, %v", parsed, failure)
	}
}

func TestParseTokenBoundsTheLink(t *testing.T) {
	if _, failure := parseToken(input(`{"token":"` + strings.Repeat("t", 201) + `"}`)); failure == nil {
		t.Error("a 201 character token passed")
	}
	if token, failure := parseToken(input(`{"token":"` + strings.Repeat("t", 200) + `"}`)); failure != nil || len(token) != 200 {
		t.Errorf("a 200 character token failed: %v", failure)
	}
	if _, failure := parseToken(input(`{"token":""}`)); failure == nil {
		t.Error("an empty token passed")
	}
	if _, failure := parseToken(input(`[]`)); failure == nil {
		t.Error("an array passed")
	}
}
