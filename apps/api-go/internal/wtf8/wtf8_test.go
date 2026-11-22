package wtf8

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUnmarshalKeepsUnpairedSurrogatesAndMarshalWritesThemBack(t *testing.T) {
	type nested struct {
		Key string `json:"key"`
	}
	type input struct {
		Name   string   `json:"name"`
		Plain  string   `json:"plain"`
		Nested nested   `json:"nested"`
		Items  []string `json:"items"`
		Keys   map[string]string
	}
	raw := `{"name":"x\ud800y","plain":"héllo","nested":{"key":"a\udc00b"},"items":["i\ud800j"],"keys":{"k\ud800":"v"}}`
	var decoded input
	if err := Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Name != "x"+string(surrogateBytes(0xD800))+"y" {
		t.Fatalf("name = %q", decoded.Name)
	}
	if decoded.Plain != "héllo" {
		t.Fatalf("plain = %q", decoded.Plain)
	}
	if decoded.Nested.Key != "a"+string(surrogateBytes(0xDC00))+"b" {
		t.Fatalf("nested key = %q", decoded.Nested.Key)
	}
	if len(decoded.Items) != 1 || decoded.Items[0] != "i"+string(surrogateBytes(0xD800))+"j" {
		t.Fatalf("items = %q", decoded.Items)
	}
	var key string
	for candidate := range decoded.Keys {
		key = candidate
	}
	if key != "k"+string(surrogateBytes(0xD800)) {
		t.Fatalf("map key = %q", key)
	}

	body, err := Marshal(decoded)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"name":"x\ud800y","plain":"héllo","nested":{"key":"a\udc00b"},"items":["i\ud800j"],"Keys":{"k\ud800":"v"}}`
	if string(body) != want {
		t.Fatalf("Marshal = %s\nwant      %s", body, want)
	}
}

func TestPairAndMarkerSurvive(t *testing.T) {
	type value struct {
		Emoji  string `json:"emoji"`
		Marker string `json:"marker"`
	}
	var decoded value
	if err := Unmarshal([]byte(`{"emoji":"\ud83d\ude00","marker":"m\ufc00n\ufc01o"}`), &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Emoji != "😀" {
		t.Fatalf("emoji = %q", decoded.Emoji)
	}
	if decoded.Marker != "m\ufc00n\ufc01o" {
		t.Fatalf("marker = %q", decoded.Marker)
	}
	body, err := Marshal(decoded)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(body) != `{"emoji":"😀","marker":"m`+"\ufc00"+`n`+"\ufc01"+`o"}` {
		t.Fatalf("Marshal = %s", body)
	}
}

func TestMalformedJSONKeepsTheStandardError(t *testing.T) {
	var target any
	err := Unmarshal([]byte(`{"a":`), &target)
	if err == nil || !strings.Contains(err.Error(), "unexpected end of JSON input") {
		t.Fatalf("err = %v", err)
	}
}

func TestZodLengthsMatchTheCodePointFallback(t *testing.T) {
	emoji := "😀"
	if got := Length(emoji); got != 2 {
		t.Fatalf("Length(emoji) = %d", got)
	}
	if got := CodePoints(emoji); got != 1 {
		t.Fatalf("CodePoints(emoji) = %d", got)
	}
	if !ZodMaxPass(strings.Repeat(emoji, 200), 200) {
		t.Fatal("200 emoji must pass a 200 maximum")
	}
	if ZodMaxPass(strings.Repeat(emoji, 201), 200) {
		t.Fatal("201 emoji must fail a 200 maximum")
	}
	lone := "a" + string(surrogateBytes(0xD800)[:])
	if got := Length(lone); got != 2 {
		t.Fatalf("Length(lone) = %d", got)
	}
	if !ZodMaxPass(lone, 2) || ZodMaxPass(lone, 1) {
		t.Fatal("a lone surrogate counts one unit")
	}
	if FromUnits(Units("x"+lone+"y")) != "x"+lone+"y" {
		t.Fatalf("unit round trip = %q", FromUnits(Units("x"+lone+"y")))
	}
}

func TestReplaceSurrogatesKeepsNUL(t *testing.T) {
	surrogate := string(surrogateBytes(0xDC00)[:])
	got := ReplaceSurrogates("a" + surrogate + "\x00b")
	if got != "a\uFFFD\x00b" {
		t.Fatalf("ReplaceSurrogates = %q", got)
	}
}

func TestSanitizeTextIsThePrismaWriteRule(t *testing.T) {
	surrogate := string(surrogateBytes(0xD800))
	cases := []struct{ in, want string }{
		{"plain\ttext", "plain\ttext"},
		{"a\x00b", "a\uFFFDb"},
		{"a" + surrogate + "b", "a\uFFFDb"},
		{"pair 😀", "pair 😀"},
	}
	for _, c := range cases {
		if got := SanitizeText(c.in); got != c.want {
			t.Errorf("SanitizeText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMarshalNil(t *testing.T) {
	body, err := Marshal(nil)
	if err != nil || string(body) != "null" {
		t.Fatalf("Marshal(nil) = %s, %v", body, err)
	}
}

func TestMarshalOutputIsValidJSON(t *testing.T) {
	value := map[string]any{"a": "x" + string(surrogateBytes(0xD800)) + "y"}
	body, err := Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("output is not JSON: %v (%s)", err, body)
	}
	if parsed["a"] != "x\uFFFDy" {
		t.Fatalf("stdlib parse = %q", parsed["a"])
	}
}
