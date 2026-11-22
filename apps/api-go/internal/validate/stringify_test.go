package validate

import "testing"

// Stringify must print a decoded value as JSON.parse then JSON.stringify would.
func TestStringifyMatchesJavaScript(t *testing.T) {
	for input, want := range map[string]string{
		`{"b": 1, "a": [1.0, 2.50, 1e3, -0, 1e21, 1E-7, 0.1]}`:        `{"b":1,"a":[1,2.5,1000,0,1e+21,1e-7,0.1]}`,
		`{"b": 1, "2": 2, "1": 3, "a": 4, "01": 5}`:                   `{"1":3,"2":2,"b":1,"a":4,"01":5}`,
		`{"__proto__": {"x": 1}, "a": 1}`:                             `{"__proto__":{"x":1},"a":1}`,
		`{"q\"": "t\t n\n b\\ s\/ \b\f \u0001 \u001f \u2029 \u007f"}`: "{\"q\\\"\":\"t\\t n\\n b\\\\ s/ \\b\\f \\u0001 \\u001f \u2029 \u007f\"}",
		`[1e400, -1e400, 5e-324, 123456789012345678901234567890]`:     `[null,null,5e-324,1.2345678901234568e+29]`,
		`{"a": [[], {}, [{"e": null}]], "t": true, "<&>": "<&>"}`:     `{"a":[[],{},[{"e":null}]],"t":true,"<&>":"<&>"}`,
	} {
		value, err := DecodeAny([]byte(input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got := Stringify(value); got != want {
			t.Errorf("Stringify(%s) = %s, want %s", input, got, want)
		}
	}
}

func TestStringifyKeepsALoneSurrogateAsAnEscape(t *testing.T) {
	value, err := DecodeAny([]byte(`{"s":"a\ud800b"}`))
	if err != nil {
		t.Fatalf("DecodeAny: %v", err)
	}
	if got := Stringify(value); got != `{"s":"a\ud800b"}` {
		t.Fatalf("Stringify = %s", got)
	}
}
