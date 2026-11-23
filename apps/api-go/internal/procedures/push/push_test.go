package push

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func raw(input string) orpc.Input {
	return orpc.Input{Raw: json.RawMessage(input)}
}

// codes is each issue's code and path, in order, which is what the wire shows.
// failureIssues is the issue list the BAD_REQUEST envelope carries.
func failureIssues(failure *orpc.Error) []validate.Issue {
	data, _ := failure.Data.(map[string]any)
	issues, _ := data["issues"].([]validate.Issue)
	return issues
}

func codes(failure *orpc.Error) []string {
	if failure == nil {
		return nil
	}
	issues := failureIssues(failure)
	found := make([]string, 0, len(issues))
	for _, issue := range issues {
		path, _ := issue["path"].([]any)
		code, _ := issue["code"].(string)
		for _, step := range path {
			code += ":" + step.(string)
		}
		found = append(found, code)
	}
	return found
}

func TestParseRegisterMatchesTheContract(t *testing.T) {
	valid := "/^\\S+$/"
	cases := []struct {
		name   string
		input  string
		codes  []string
		token  string
		pres   string
		detail map[string]any
	}{
		{name: "valid", input: `{"token":"abcdefgh"}`, token: "abcdefgh"},
		{name: "valid-presentation", input: `{"token":"abcdefgh","presentation":"android_sender"}`, token: "abcdefgh", pres: "android_sender"},
		{name: "unknown-key-ignored", input: `{"token":"abcdefgh","extra":1}`, token: "abcdefgh"},
		{
			name: "too-short", input: `{"token":"abcdefg"}`,
			codes: []string{"too_small:token"}, detail: map[string]any{
				"origin": "string", "code": "too_small", "minimum": 8, "inclusive": true,
				"path": []any{"token"}, "message": "Too small: expected string to have >=8 characters",
			},
		},
		{
			name: "too-long", input: `{"token":"` + repeat("a", 513) + `"}`,
			codes: []string{"too_big:token"},
		},
		{
			name: "space", input: `{"token":"has space"}`,
			codes: []string{"invalid_format:token"}, detail: map[string]any{
				"origin": "string", "code": "invalid_format", "format": "regex", "pattern": valid,
				"path": []any{"token"}, "message": "Invalid string: must match pattern " + valid,
			},
		},
		// zod accepts every code point as \S but no ECMAScript whitespace; a
		// trailing newline is not covered by `$`.
		{name: "trailing-newline", input: `{"token":"abcdefgh\n"}`, codes: []string{"invalid_format:token"}},
		{name: "trailing-crlf", input: `{"token":"abcdefgh\r\n"}`, codes: []string{"invalid_format:token"}},
		{name: "nbsp", input: "{\"token\":\"abcdefg\\u00a0\"}", codes: []string{"invalid_format:token"}},
		{name: "line-separator", input: "{\"token\":\"abcdefg\\u2028\"}", codes: []string{"invalid_format:token"}},
		{name: "bom", input: "{\"token\":\"abcdefg\\ufeff\"}", codes: []string{"invalid_format:token"}},
		{name: "astral-counts-as-one", input: `{"token":"😀😀😀😀"}`, codes: []string{"too_small:token"}},
		{
			name: "wrong-type", input: `{"token":42}`,
			codes: []string{"invalid_type:token"},
		},
		{
			name: "array-length-checked", input: `{"token":["aaaaaaaa"]}`,
			codes: []string{"invalid_type:token", "too_small:token"},
		},
		{
			name: "presentation-wrong", input: `{"token":"abcdefgh","presentation":"nope"}`,
			codes: []string{"invalid_value:presentation"}, detail: map[string]any{
				"code": "invalid_value", "values": []string{"android_sender"},
				"path": []any{"presentation"}, "message": `Invalid input: expected "android_sender"`,
			},
		},
		{name: "presentation-null", input: `{"token":"abcdefgh","presentation":null}`, codes: []string{"invalid_value:presentation"}},
		{
			name: "token-and-presentation", input: `{"token":"short","presentation":"nope"}`,
			codes: []string{"too_small:token", "invalid_value:presentation"},
		},
		{name: "missing-input", input: ``, codes: []string{"invalid_type"}},
		{name: "null-input", input: `null`, codes: []string{"invalid_type"}},
		{name: "array-input", input: `[]`, codes: []string{"invalid_type"}},
		{name: "missing-token", input: `{}`, codes: []string{"invalid_type:token"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, failure := ParseRegister(raw(testCase.input))
			if len(testCase.codes) == 0 {
				if failure != nil {
					t.Fatalf("unexpected failure %v", failure)
				}
				if parsed.Token != testCase.token || parsed.Presentation != testCase.pres {
					t.Fatalf("parsed = %+v", parsed)
				}
				return
			}
			if failure == nil {
				t.Fatalf("expected %v, parsed %+v", testCase.codes, parsed)
			}
			if failure.Status != 400 || failure.Code != "BAD_REQUEST" || failure.Message != "Input validation failed" {
				t.Fatalf("envelope = %+v", failure)
			}
			if got := codes(failure); !reflect.DeepEqual(got, testCase.codes) {
				t.Fatalf("codes = %v, want %v", got, testCase.codes)
			}
			if testCase.detail != nil {
				issues := failureIssues(failure)
				if !reflect.DeepEqual(issues[0], testCase.detail) {
					t.Fatalf("issue = %#v", issues[0])
				}
			}
		})
	}
}

func repeat(text string, count int) string {
	out := ""
	for range count {
		out += text
	}
	return out
}

func TestParseCallMatchesTheContract(t *testing.T) {
	const device = "00000000-0000-4000-8000-000000000000"
	const voip = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	cases := []struct {
		name  string
		input string
		codes []string
	}{
		{name: "ios-voip", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + voip + `"}`},
		{name: "android-expo", input: `{"deviceId":"` + device + `","platform":"android","expoToken":"ExponentPushToken[abc]"}`},
		{name: "both-tokens", input: `{"deviceId":"` + device + `","platform":"ios","expoToken":"ExponentPushToken[abc]","voipToken":"` + voip + `"}`},
		{name: "nil-uuid", input: `{"deviceId":"00000000-0000-0000-0000-000000000000","platform":"android","expoToken":"ExponentPushToken[abc]"}`},
		{name: "ones-uuid", input: `{"deviceId":"ffffffff-ffff-ffff-ffff-ffffffffffff","platform":"android","expoToken":"ExponentPushToken[abc]"}`},
		{name: "uppercase-uuid", input: `{"deviceId":"FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF","platform":"android","expoToken":"ExponentPushToken[abc]"}`},
		{name: "no-tokens-refine", input: `{"deviceId":"` + device + `","platform":"android"}`, codes: []string{"custom"}},
		{name: "ios-keeps-voip", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + voip + `"}`},
		{
			name: "android-voip-only", input: `{"deviceId":"` + device + `","platform":"android","voipToken":"` + voip + `"}`,
			codes: []string{"custom"},
		},
		{
			name: "uuid-v9", input: `{"deviceId":"123e4567-e89b-92d3-a456-426614174000","platform":"android","expoToken":"ExponentPushToken[abc]"}`,
			codes: []string{"invalid_format:deviceId"},
		},
		{
			name: "uuid-variant", input: `{"deviceId":"123e4567-e89b-12d3-c456-426614174000","platform":"android","expoToken":"ExponentPushToken[abc]"}`,
			codes: []string{"invalid_format:deviceId"},
		},
		{
			name: "uuid-and-refine", input: `{"deviceId":"x","platform":"android"}`,
			codes: []string{"invalid_format:deviceId", "custom"},
		},
		{
			// invalid_value aborts the pipeline, so the refinement never runs.
			name: "platform-aborts-refine", input: `{"deviceId":"x","platform":"web"}`,
			codes: []string{"invalid_format:deviceId", "invalid_value:platform"},
		},
		{name: "platform-wrong", input: `{"deviceId":"` + device + `","platform":"iOS","expoToken":"ExponentPushToken[abc]"}`, codes: []string{"invalid_value:platform"}},
		{name: "platform-null", input: `{"deviceId":"` + device + `","platform":null,"expoToken":"ExponentPushToken[abc]"}`, codes: []string{"invalid_value:platform"}},
		{
			name: "expo-short-with-android", input: `{"deviceId":"` + device + `","platform":"android","expoToken":"short"}`,
			// The refinement reads the sent (truthy) value, so no custom issue.
			codes: []string{"too_small:expoToken"},
		},
		{
			name: "expo-space", input: `{"deviceId":"` + device + `","platform":"android","expoToken":"has space"}`,
			codes: []string{"invalid_format:expoToken"},
		},
		{
			name: "expo-empty", input: `{"deviceId":"` + device + `","platform":"android","expoToken":""}`,
			// Empty is falsy raw, and min also fails.
			codes: []string{"too_small:expoToken", "invalid_format:expoToken", "custom"},
		},
		{
			name: "voip-newline", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + voip + `\n"}`,
			codes: []string{"invalid_format:voipToken"},
		},
		{
			name: "voip-short", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + voip[:63] + `"}`,
			codes: []string{"invalid_format:voipToken"},
		},
		{name: "voip-201", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + repeat("a", 201) + `"}`, codes: []string{"invalid_format:voipToken"}},
		{name: "voip-200-ok", input: `{"deviceId":"` + device + `","platform":"ios","voipToken":"` + repeat("a", 200) + `"}`},
		{name: "missing-all", input: `{}`, codes: []string{"invalid_type:deviceId", "invalid_value:platform"}},
		{name: "missing-device-only", input: `{"platform":"android","expoToken":"ExponentPushToken[abc]"}`, codes: []string{"invalid_type:deviceId"}},
		{name: "non-object", input: `5`, codes: []string{"invalid_type"}},
		{name: "null", input: `null`, codes: []string{"invalid_type"}},
		{name: "array", input: `[]`, codes: []string{"invalid_type"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, failure := ParseCall(raw(testCase.input))
			if len(testCase.codes) == 0 {
				if failure != nil {
					t.Fatalf("unexpected failure %v", failure)
				}
				if parsed.DeviceID == "" || parsed.Platform == "" {
					t.Fatalf("parsed = %+v", parsed)
				}
				return
			}
			if failure == nil {
				t.Fatalf("expected %v, parsed %+v", testCase.codes, parsed)
			}
			if got := codes(failure); !reflect.DeepEqual(got, testCase.codes) {
				t.Fatalf("codes = %v, want %v", got, testCase.codes)
			}
		})
	}
}

func TestMergeRegistrationKeepsJavaScriptOrder(t *testing.T) {
	previous, err := validate.DecodeAny([]byte(`{"deviceId":"old","platform":"ios","voipToken":"v","expoToken":"e"}`))
	if err != nil {
		t.Fatal(err)
	}
	merged := mergeRegistration(previous, CallInput{
		DeviceID: "new", Platform: "android", ExpoToken: "e2", HasExpo: true,
	})
	want := `{"deviceId":"new","platform":"android","voipToken":"v","expoToken":"e2"}`
	if got := validate.Stringify(merged); got != want {
		t.Fatalf("merged = %s, want %s", got, want)
	}
	// A registration that sends no VoIP token keeps the stored one.
	merged = mergeRegistration(previous, CallInput{DeviceID: "new", Platform: "ios"})
	want = `{"deviceId":"new","platform":"ios","voipToken":"v","expoToken":"e"}`
	if got := validate.Stringify(merged); got != want {
		t.Fatalf("merged without voip = %s, want %s", got, want)
	}
	// No previous row: the registration's own shape order.
	merged = mergeRegistration(nil, CallInput{DeviceID: "new", Platform: "ios", VoipToken: "v", HasVoip: true})
	want = `{"deviceId":"new","platform":"ios","voipToken":"v"}`
	if got := validate.Stringify(merged); got != want {
		t.Fatalf("first registration = %s, want %s", got, want)
	}
}

func TestSpreadsFollowJavaScript(t *testing.T) {
	for _, testCase := range []struct{ previous, want string }{
		{`["a","b"]`, `{"0":"a","1":"b","deviceId":"d","platform":"ios"}`},
		{`"ab"`, `{"0":"a","1":"b","deviceId":"d","platform":"ios"}`},
		{`5`, `{"deviceId":"d","platform":"ios"}`},
		{`null`, `{"deviceId":"d","platform":"ios"}`},
		{`{"z":1,"0":"zero"}`, `{"0":"zero","z":1,"deviceId":"d","platform":"ios"}`},
	} {
		previous, err := validate.DecodeAny([]byte(testCase.previous))
		if err != nil {
			t.Fatal(err)
		}
		merged := mergeRegistration(previous, CallInput{DeviceID: "d", Platform: "ios"})
		if got := validate.Stringify(merged); got != testCase.want {
			t.Fatalf("previous %s spread to %s, want %s", testCase.previous, got, testCase.want)
		}
	}
}

func TestDigestAndCredentialRules(t *testing.T) {
	// credentialDigest("ExponentPushToken[abc]") and sha256 of the trimmed token.
	if got := credentialDigest("abcdefgh"); got != "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab" {
		t.Fatalf("digest = %s", got)
	}
	for _, testCase := range []struct {
		name  string
		value any
		want  *string
		fail  bool
	}{
		{name: "absent", value: nil},
		{name: "empty", value: ""},
		{name: "number-zero", value: json.Number("0")},
		{name: "string", value: "a", want: new(credentialDigest("a"))},
		// createHash.update(5) throws in TypeScript: a truthy non-string is a 500.
		{name: "number", value: json.Number("5"), fail: true},
		{name: "object", value: &validate.Object{}, fail: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := registrationDigest(testCase.value)
			if testCase.fail != (err != nil) {
				t.Fatalf("err = %v", err)
			}
			if testCase.want == nil {
				if got != nil {
					t.Fatalf("got %v, want null", *got)
				}
				return
			}
			if got == nil || *got != *testCase.want {
				t.Fatalf("got %v, want %v", got, *testCase.want)
			}
		})
	}
}

func TestTokenRules(t *testing.T) {
	for _, testCase := range []struct {
		value string
		want  bool
	}{
		{"abcdefgh", true},
		{"abcdefg ", false},
		{"abcdefg\n", false},
		{"a\nbcdefg", false},
		{"abcdefg\u00a0", false},
		{"😀😀😀😀", true},
		{"", false},
		{"\u200b", true}, // zero-width space is not ECMAScript \s
	} {
		if got := nonSpace(testCase.value); got != testCase.want {
			t.Fatalf("nonSpace(%q) = %v", testCase.value, got)
		}
	}
	if !hexToken(repeat("A", 64)) || !hexToken(repeat("0", 200)) {
		t.Fatal("valid hex tokens rejected")
	}
	if hexToken(repeat("g", 64)) || hexToken(repeat("a", 63)) || hexToken(repeat("a", 201)) {
		t.Fatal("invalid hex tokens accepted")
	}
}
