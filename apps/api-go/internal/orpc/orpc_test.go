package orpc

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMarshalMatchesJSONStringify(t *testing.T) {
	body, err := Marshal(map[string]string{"value": "<a>&b"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(body) != `{"value":"<a>&b"}` {
		t.Errorf("body = %s", body)
	}
}

func TestWriteErrorEnvelope(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteError(recorder, Conflict("already there"))
	if recorder.Code != 409 || recorder.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status/content-type = %d %q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	var envelope struct {
		JSON map[string]any `json:"json"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if envelope.JSON["code"] != "CONFLICT" || envelope.JSON["status"] != float64(409) || envelope.JSON["defined"] != false {
		t.Errorf("envelope = %v", envelope.JSON)
	}
	if strings.Contains(recorder.Body.String(), "\n") {
		t.Error("envelope has a trailing newline")
	}
}

func TestDecodeInput(t *testing.T) {
	request := httptest.NewRequest("POST", "/rpc/me", strings.NewReader(`{"json":{"ok":true}}`))
	request.Header.Set("Content-Type", "application/json")
	input, failure := DecodeInput(request, 1024)
	if failure != nil || !input.HasInput() || string(input.Raw) != `{"ok":true}` {
		t.Fatalf("input = %+v failure=%v", input, failure)
	}

	empty := httptest.NewRequest("POST", "/rpc/me", strings.NewReader(""))
	if input, failure := DecodeInput(empty, 1024); failure != nil || input.HasInput() {
		t.Errorf("empty body = %+v %v", input, failure)
	}

	malformed := httptest.NewRequest("POST", "/rpc/me", strings.NewReader("{nope"))
	if _, failure := DecodeInput(malformed, 1024); failure == nil || failure.Status != 400 {
		t.Errorf("malformed failure = %v", failure)
	}

	tooLarge := httptest.NewRequest("POST", "/rpc/me", strings.NewReader(strings.Repeat("x", 64)))
	tooLarge.ContentLength = 64
	if _, failure := DecodeInput(tooLarge, 16); failure == nil || failure.Status != 413 {
		t.Errorf("oversized failure = %v", failure)
	}
}

func TestMarshalWritesLineSeparatorsLikeJSONStringify(t *testing.T) {
	body, err := Marshal(map[string]any{"a": "x\u2028y\u2029z", "b": `\u2028 literal`, "c": "<&>"})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"a\":\"x\u2028y\u2029z\",\"b\":\"\\\\u2028 literal\",\"c\":\"<&>\"}"
	if string(body) != want {
		t.Fatalf("got %q want %q", body, want)
	}
}
