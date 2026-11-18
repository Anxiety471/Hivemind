package capabilities

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// installConfig passes a stored object on as JSON.parse then JSON.stringify would, drops
// a "__proto__" key as z.record does, and reads anything else as {}.
func TestInstallConfigMatchesTheRecordParse(t *testing.T) {
	for stored, want := range map[string]string{
		`{"b": 1, "a": [1.0, 1e3], "10": "x", "2": "y"}`:        `{"2":"y","10":"x","b":1,"a":[1,1000]}`,
		`{"__proto__": {"x": 1}, "a": 1}`:                       `{"a":1}`,
		`{"a": {"__proto__": {"x": 1}}, "__proto__": {"y": 2}}`: `{"a":{}}`,
		`{"l": [{"__proto__": 1, "k": 2}, [{"__proto__": 3}]]}`: `{"l":[{"k":2},[{}]]}`,
		`{}`:                               `{}`,
		`{"k": "\u2028 <b> & \"q\" \\ /"}`: "{\"k\":\"\u2028 <b> & \\\"q\\\" \\\\ /\"}",
	} {
		if got := string(installConfig("row", []byte(stored), nil)); got != want {
			t.Errorf("installConfig(%s) = %s, want %s", stored, got, want)
		}
	}
	for _, stored := range []string{`[1]`, `"x"`, `5`, `null`, `true`, `not json`} {
		if got := string(installConfig("row", []byte(stored), nil)); got != `{}` {
			t.Errorf("installConfig(%s) = %s, want {}", stored, got)
		}
	}
}

// Stringify is what carries the stored settings out; check it against the same corners.
func TestStringifyNumberForms(t *testing.T) {
	value, err := validate.DecodeAny([]byte(`{"n": [1e400, -1e400, 5e-324, 0.1, -0, 1e21]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"n":[null,null,5e-324,0.1,0,1e+21]}`
	if got := validate.Stringify(value); got != want {
		t.Errorf("Stringify = %s, want %s", got, want)
	}
}
