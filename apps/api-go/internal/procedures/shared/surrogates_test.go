package shared

import (
	"encoding/json"
	"testing"
)

func TestEchoTextKeepsUnpairedSurrogates(t *testing.T) {
	cases := []struct {
		request string
		want    string
		ok      bool
	}{
		{`{"name":"a\ud800b"}`, `"a\ud800b"`, true},
		{`{"name":"a\uD800b"}`, `"a\ud800b"`, true},
		{`{"name":"  x\uD800\t "}`, `"x\ud800"`, true},
		{`{"name":"a\udc00"}`, `"a\udc00"`, true},
		{`{"name":"\ud800\ud800"}`, `"\ud800\ud800"`, true},
		{`{"name":"\ud83d\ude00\ud800"}`, `"😀\ud800"`, true},
		{`{"name":"\u0041\ud800\n\"\\é"}`, `"A\ud800\n\"\\é"`, true},
		{`{"name":"a","name":"b\ud800"}`, `"b\ud800"`, true},
		// A well-formed string is already exact once decoded.
		{`{"name":"\ud83d\ude00"}`, "", false},
		{`{"name":"plain"}`, "", false},
		{`{"other":"a\ud800"}`, "", false},
		{`{"name":5}`, "", false},
		{`[]`, "", false},
	}
	for _, c := range cases {
		got, ok := EchoText(json.RawMessage(c.request), "name")
		if ok != c.ok || string(got) != c.want {
			t.Errorf("EchoText(%s) = %s, %t; want %s, %t", c.request, got, ok, c.want, c.ok)
		}
		if ok && !json.Valid(got) {
			t.Errorf("EchoText(%s) is not valid JSON: %s", c.request, got)
		}
	}
}
