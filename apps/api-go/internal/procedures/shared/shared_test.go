package shared

import (
	"encoding/json"
	"testing"
)

// OutputInvalid must answer exactly what the TypeScript router answers when a result
// breaks its contract schema: the 500 with its own message, no data fields.
func TestOutputInvalidMatchesTheRouter(t *testing.T) {
	failure := OutputInvalid()
	if failure.Code != "INTERNAL_SERVER_ERROR" || failure.Status != 500 || failure.Message != "Output validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	body, err := json.Marshal(failure.Data)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "null" {
		t.Fatalf("data = %s", body)
	}
}
