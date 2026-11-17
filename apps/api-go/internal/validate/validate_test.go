package validate

import (
	"encoding/json"
	"reflect"
	"testing"
)

func messages(issues []Issue) []string {
	var out []string
	for _, issue := range issues {
		out = append(out, issue["message"].(string))
	}
	return out
}

func TestObjectKeysFollowJavaScriptOrder(t *testing.T) {
	object, issues := Decode(json.RawMessage(`{"b":1,"2":1,"1":1,"a":1,"b":2}`), nil)
	if issues != nil || !reflect.DeepEqual(object.Keys, []string{"1", "2", "b", "a"}) {
		t.Fatalf("keys = %v %v", object, issues)
	}
	if v, _ := object.Get("b"); v.(json.Number).String() != "2" {
		t.Error("the last duplicate wins")
	}
	if got := object.Unrecognized(nil, "a"); got[0]["message"] != `Unrecognized keys: "1", "2", "b"` {
		t.Errorf("%v", got)
	}
}

func TestDecodeReportsWhatWasSentInsteadOfAnObject(t *testing.T) {
	for raw, want := range map[string]string{
		"":      "Invalid input: expected object, received undefined",
		"null":  "Invalid input: expected object, received null",
		"[]":    "Invalid input: expected object, received array",
		`"x"`:   "Invalid input: expected object, received string",
		"3":     "Invalid input: expected object, received number",
		"false": "Invalid input: expected object, received boolean",
	} {
		_, issues := Decode(json.RawMessage(raw), nil)
		if len(issues) != 1 || issues[0]["message"] != want {
			t.Errorf("%q: %v", raw, issues)
		}
	}
}

func TestStringChecks(t *testing.T) {
	if got, issues := String(Path{"s"}, "  hi \n", StringRules{Trim: true, Min: 1, Max: 2}); issues != nil || got != "hi" {
		t.Errorf("%q %v", got, issues)
	}
	if _, issues := String(Path{"s"}, "  ", StringRules{Trim: true, Min: 1}); !reflect.DeepEqual(messages(issues), []string{"Too small: expected string to have >=1 characters"}) {
		t.Errorf("%v", issues)
	}
	// An empty array has a length too: the type issue is followed by the length issue.
	_, issues := String(Path{"s"}, []any{}, StringRules{Min: 1})
	if !reflect.DeepEqual(messages(issues), []string{"Invalid input: expected string, received array", "Too small: expected array to have >=1 items"}) {
		t.Errorf("%v", messages(issues))
	}
	if _, issues := String(Path{"s"}, 5, StringRules{Min: 1}); len(issues) != 1 {
		t.Errorf("a number has no length: %v", issues)
	}
	if _, issues := String(Path{"s"}, Undefined, StringRules{Min: 1}); messages(issues)[0] != "Invalid input: expected string, received undefined" {
		t.Errorf("%v", issues)
	}
}

func TestIntegerChecks(t *testing.T) {
	rules := NumberRules{Gt: Float(0), Max: Float(100)}
	num := func(s string) any { return json.Number(s) }
	if got, issues := Integer(Path{"n"}, num("5"), rules); issues != nil || got != 5 {
		t.Errorf("%d %v", got, issues)
	}
	if got, issues := Integer(Path{"n"}, num("5.0"), rules); issues != nil || got != 5 {
		t.Errorf("5.0 is an integer: %d %v", got, issues)
	}
	for raw, want := range map[string][]string{
		"0":      {"Too small: expected number to be >0"},
		"101":    {"Too big: expected number to be <=100"},
		"1.5":    {"Invalid input: expected int, received number"},
		"1e400":  {"Invalid input: expected number, received Infinity"},
		"1e300":  {"Too big: expected int to be <=9007199254740991", "Too big: expected number to be <=100"},
		"-1e300": {"Too small: expected int to be >=-9007199254740991", "Too small: expected number to be >0"},
	} {
		_, issues := Integer(Path{"n"}, num(raw), rules)
		if !reflect.DeepEqual(messages(issues), want) {
			t.Errorf("%s: %v", raw, messages(issues))
		}
	}
	if _, issues := Integer(Path{"n"}, "5", rules); messages(issues)[0] != "Invalid input: expected number, received string" {
		t.Errorf("%v", issues)
	}
}

func TestEnum(t *testing.T) {
	if got, issues := Enum(Path{"e"}, "usd", "usd", "eur"); issues != nil || got != "usd" {
		t.Error(issues)
	}
	for _, bad := range []any{"gbp", 5, nil, Undefined, []any{}} {
		_, issues := Enum(Path{"e"}, bad, "usd", "eur")
		if len(issues) != 1 || issues[0]["code"] != "invalid_value" || issues[0]["message"] != `Invalid option: expected one of "usd"|"eur"` {
			t.Errorf("%v: %v", bad, issues)
		}
	}
}
