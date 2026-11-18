package pages

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// foldTitle is title.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim().
func TestFoldTitle(t *testing.T) {
	for in, want := range map[string]string{
		"plain":                  "plain",
		"  padded  ":             "padded",
		"a\tb\nc\rd":             "a b c d",
		"a \u00a0 \u3000 b":      "a b",
		"a\u0000b":               "a b",
		"a\u0085b":               "a b",
		"a\u007fb":               "a b",
		"a\u2028b\u2029c":        "a b c",
		"\ufeffa\ufeff":          "a",
		"\u0000\u0000":           "",
		"":                       "",
		"a\u200bb":               "a\u200bb", // zero width space is not whitespace
		"a\u180eb":               "a\u180eb", // the Mongolian vowel separator is not either
		"a\u00adb":               "a\u00adb", // soft hyphen is a format character, not a control
		"keep   inner\u2003runs": "keep inner runs",
		"😀 \t 😀":                 "😀 😀",
	} {
		if got := foldTitle(in); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
}

func renameIssues(t *testing.T, body string) []map[string]any {
	t.Helper()
	_, _, failure := parseRename(orpc.Input{Raw: json.RawMessage(body)})
	if failure == nil {
		return nil
	}
	return failure.Data.(map[string]any)["issues"].([]map[string]any)
}

func messages(issues []map[string]any) []string {
	var out []string
	for _, issue := range issues {
		out = append(out, issue["code"].(string)+": "+issue["message"].(string))
	}
	return out
}

func TestParseRenameFollowsTheTitleSchema(t *testing.T) {
	if id, title, failure := parseRename(orpc.Input{Raw: json.RawMessage(`{"pageId":"p","title":" \u0000 a\n b "}`)}); failure != nil || id != "p" || title != "a b" {
		t.Fatalf("valid = %q %q %v", id, title, failure)
	}
	for name, tc := range map[string]struct {
		body string
		want []string
	}{
		"blank folds to nothing":   {`{"pageId":"p","title":" \u0000\t"}`, []string{"too_small: Too small: expected string to have >=1 characters"}},
		"empty":                    {`{"pageId":"p","title":""}`, []string{"too_small: Too small: expected string to have >=1 characters"}},
		"201 characters":           {`{"pageId":"p","title":"` + strings.Repeat("x", 201) + `"}`, []string{"too_big: Too big: expected string to have <=200 characters"}},
		"folds below the limit":    {`{"pageId":"p","title":"` + strings.Repeat("x ", 100) + `"}`, nil},
		"not a string":             {`{"pageId":"p","title":5}`, []string{"invalid_type: Invalid input: expected string, received number"}},
		"array has no length rule": {`{"pageId":"p","title":[]}`, []string{"invalid_type: Invalid input: expected string, received array"}},
		"missing title":            {`{"pageId":"p"}`, []string{"invalid_type: Invalid input: expected string, received undefined"}},
		"missing both":             {`{}`, []string{"invalid_type: Invalid input: expected string, received undefined", "invalid_type: Invalid input: expected string, received undefined"}},
		"empty id and long title":  {`{"pageId":"","title":"` + strings.Repeat("x", 201) + `"}`, []string{"too_small: Too small: expected string to have >=1 characters", "too_big: Too big: expected string to have <=200 characters"}},
		"strict object":            {`{"pageId":"p","title":"t","extra":1,"2":1}`, []string{`unrecognized_keys: Unrecognized keys: "2", "extra"`}},
		"issues before the keys":   {`{"pageId":5,"extra":1}`, []string{"invalid_type: Invalid input: expected string, received number", "invalid_type: Invalid input: expected string, received undefined", `unrecognized_keys: Unrecognized key: "extra"`}},
		"not an object":            {`[]`, []string{"invalid_type: Invalid input: expected object, received array"}},
	} {
		if got := messages(renameIssues(t, tc.body)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
	// 200 code points of four bytes are within the limit (zod counts code points).
	if got := renameIssues(t, `{"pageId":"p","title":"`+strings.Repeat("😀", 200)+`"}`); got != nil {
		t.Errorf("200 emoji: %v", got)
	}
	if got := renameIssues(t, `{"pageId":"p","title":"`+strings.Repeat("😀", 201)+`"}`); len(got) != 1 {
		t.Errorf("201 emoji: %v", got)
	}
}

func TestParsePin(t *testing.T) {
	if id, pinned, failure := parsePin(orpc.Input{Raw: json.RawMessage(`{"pageId":"p","pinned":false}`)}); failure != nil || id != "p" || pinned {
		t.Fatalf("valid = %q %v %v", id, pinned, failure)
	}
	for name, tc := range map[string]struct {
		body string
		want []string
	}{
		"not boolean": {`{"pageId":"p","pinned":"yes"}`, []string{"invalid_type: Invalid input: expected boolean, received string"}},
		"missing":     {`{"pageId":"p"}`, []string{"invalid_type: Invalid input: expected boolean, received undefined"}},
		"null":        {`{"pageId":"p","pinned":null}`, []string{"invalid_type: Invalid input: expected boolean, received null"}},
		"strict":      {`{"pageId":"p","pinned":true,"x":1}`, []string{`unrecognized_keys: Unrecognized key: "x"`}},
		"id and flag": {`{"pageId":"","pinned":1}`, []string{"too_small: Too small: expected string to have >=1 characters", "invalid_type: Invalid input: expected boolean, received number"}},
	} {
		_, _, failure := parsePin(orpc.Input{Raw: json.RawMessage(tc.body)})
		var got []string
		if failure != nil {
			got = messages(failure.Data.(map[string]any)["issues"].([]map[string]any))
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}
