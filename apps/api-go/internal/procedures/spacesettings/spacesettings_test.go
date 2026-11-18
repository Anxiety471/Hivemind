package spacesettings

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func TestSetInputNeedsASettingAndABoolean(t *testing.T) {
	for _, setting := range Settings {
		input, failure := parseSet(orpc.Input{Raw: json.RawMessage(`{"setting":"` + setting + `","enabled":false,"more":1}`)})
		if failure != nil || input.Setting != setting || input.Enabled {
			t.Errorf("%s: %+v %v", setting, input, failure)
		}
	}
	for _, text := range []string{`{"setting":"billing","enabled":true}`, `{"setting":"models","enabled":"true"}`, `{"setting":"models"}`, `{}`, `[]`, `null`} {
		if _, failure := parseSet(orpc.Input{Raw: json.RawMessage(text)}); failure == nil {
			t.Errorf("%s should be rejected", text)
		}
	}
}

func TestOnlySerializationFailuresAreRerun(t *testing.T) {
	for code, want := range map[string]bool{"40001": true, "40P01": true, "23505": false, "57P01": false} {
		if got := conflict(&pgconn.PgError{Code: code}); got != want {
			t.Errorf("%s: %v", code, got)
		}
	}
	if conflict(errors.New("x")) {
		t.Error("an ordinary error is not a conflict")
	}
}
