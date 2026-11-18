package scratchpad

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func in(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestCreateDefaultsAndTrimsLikeTheHandler(t *testing.T) {
	input, failure := parseCreate(in(`{"botId":"b","title":"  T \u00a0","notes":"\n n\u0000x "}`))
	if failure != nil {
		t.Fatal(failure)
	}
	if input.Title != "T" || input.Status != "open" || input.Notes != "n\uFFFDx" {
		t.Errorf("input = %+v", input)
	}
	input, failure = parseCreate(in(`{"botId":"b","title":"   "}`))
	if failure != nil || input.Title != "" {
		t.Errorf("a whitespace title passes the schema and is stored empty: %+v %v", input, failure)
	}
}

func TestCreateBoundsCountCodePointsBeforeTrimming(t *testing.T) {
	ok := `{"botId":"b","title":"` + strings.Repeat("😀", 200) + `","notes":"` + strings.Repeat("n", 4000) + `"}`
	if _, failure := parseCreate(in(ok)); failure != nil {
		t.Errorf("200 characters and 4000 notes are allowed: %v", failure)
	}
	for _, text := range []string{
		`{"botId":"b","title":"` + strings.Repeat("😀", 201) + `"}`,
		`{"botId":"b","title":"t","notes":"` + strings.Repeat("n", 4001) + `"}`,
		`{"botId":"b","title":""}`,
		`{"botId":"b","title":"t","status":null}`,
		`{"botId":"b","title":"t","notes":null}`,
	} {
		if _, failure := parseCreate(in(text)); failure == nil {
			t.Errorf("%.60s should be rejected", text)
		}
	}
}

func TestUpdateFieldsAreOptionalButNotNullable(t *testing.T) {
	input, failure := parseUpdate(in(`{"itemId":"i"}`))
	if failure != nil || input.Title != nil || input.Status != nil || input.Notes != nil {
		t.Errorf("only the id is required: %+v %v", input, failure)
	}
	for _, text := range []string{`{"itemId":"i","title":null}`, `{"itemId":"i","status":"x"}`, `{"itemId":"i","title":""}`, `{"title":"t"}`} {
		if _, failure := parseUpdate(in(text)); failure == nil {
			t.Errorf("%s should be rejected", text)
		}
	}
	input, _ = parseUpdate(in(`{"itemId":"i","notes":""}`))
	if input.Notes == nil || *input.Notes != "" {
		t.Error("empty notes clear the notes")
	}
}
