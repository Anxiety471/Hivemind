package validate

import (
	"strings"
	"testing"
)

func TestDecodeKeepsUnpairedSurrogatesInValuesAndKeys(t *testing.T) {
	object, issues := Decode([]byte(`{"name":"x\ud800y","ok":true,"bad\udc00key":1}`), nil)
	if issues != nil {
		t.Fatalf("Decode issues = %v", issues)
	}
	name, _ := object.Get("name")
	if name != "x\xed\xa0\x80y" {
		t.Fatalf("name = %q", name)
	}
	found := object.Unrecognized(nil, "name", "ok")
	if len(found) != 1 {
		t.Fatalf("Unrecognized = %v", found)
	}
	keys, _ := found[0]["keys"].([]string)
	if len(keys) != 1 || keys[0] != "bad\xed\xb0\x80key" {
		t.Fatalf("keys = %q", keys)
	}
	message, _ := found[0]["message"].(string)
	if !strings.Contains(message, "bad\xed\xb0\x80key") {
		t.Fatalf("message = %q", message)
	}
}

func TestNestedObjectAndArrayValuesKeepSurrogates(t *testing.T) {
	object, issues := Decode(
		[]byte(`{"limit":{"amount":1,"note":"a\ud800b"},"items":["c\ud800d",{"k\udc00":"v"}]}`), nil)
	if issues != nil {
		t.Fatalf("Decode issues = %v", issues)
	}
	outer, problems := AsObject(object.Field("limit"), Path{"limit"})
	if problems != nil {
		t.Fatalf("limit: %v", problems)
	}
	note, _ := outer.Get("note")
	if note != "a\xed\xa0\x80b" {
		t.Fatalf("note = %q", note)
	}
	items, _ := object.Get("items")
	list, ok := items.([]any)
	if !ok || len(list) != 2 {
		t.Fatalf("items = %#v", items)
	}
	if list[0] != "c\xed\xa0\x80d" {
		t.Fatalf("items[0] = %q", list[0])
	}
	inner, problems := AsObject(list[1], Path{"items", 0})
	if problems != nil {
		t.Fatalf("items[1]: %v", problems)
	}
	value, _ := inner.Get("k\xed\xb0\x80")
	if value != "v" {
		t.Fatalf("nested key lookup = %#v", value)
	}
}
