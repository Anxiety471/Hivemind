package orpc

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeIntoKeepsAnUnpairedSurrogateAndWriteJSONSpellsIt(t *testing.T) {
	type input struct {
		Name string `json:"name"`
	}
	var decoded input
	failure := (Input{Raw: json.RawMessage(`{"name":"x\ud800y"}`)}).DecodeInto(&decoded)
	if failure != nil {
		t.Fatalf("DecodeInto: %v", failure)
	}
	want := "x\xed\xa0\x80y" // WTF-8 for U+D800
	if decoded.Name != want {
		t.Fatalf("name = %q, want %q", decoded.Name, want)
	}

	recorder := httptest.NewRecorder()
	WriteJSON(recorder, 200, map[string]any{"json": map[string]any{"name": decoded.Name}})
	body := recorder.Body.String()
	if !strings.Contains(body, `"x\ud800y"`) {
		t.Fatalf("body = %s, want the JSON.stringify escape", body)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
}
