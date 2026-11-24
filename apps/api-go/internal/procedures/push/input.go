package push

import (
	"encoding/json"
	"math"
	"regexp"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// The patterns are printed verbatim in the invalid_format issue (zod 4 prints
// `/<source>/<flags>`); they are also the checks themselves.
const (
	tokenPatternSource = `/^\S+$/`
	voipPatternSource  = `/^[a-fA-F0-9]{64,200}$/`
	uuidPatternSource  = `/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/`
)

// uuidPattern is z.string().uuid() in zod 4: any version 1-8 with an RFC 4122
// variant, or the all-zero and all-ones special cases.
var uuidPattern = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

// RegisterInput is notifications.registerPush's input
// (packages/contracts/src/threads/threads-rpc.ts:255-263).
type RegisterInput struct {
	// Token is the trimmed registration value (the schema forbids whitespace, so
	// trimming is a no-op; the store trims anyway at push-token-store.ts:196).
	Token string
	// Presentation is "android_sender" when the installed Android build renders
	// data-only sender pushes, and empty when the key was absent.
	Presentation string
}

// CallInput is notifications.registerCallPush's input (threads-rpc.ts:238-254).
type CallInput struct {
	DeviceID  string
	Platform  string
	ExpoToken string
	VoipToken string
	HasExpo   bool
	HasVoip   bool
}

// regexIssue is zod's invalid_format for a regex check.
func regexIssue(path validate.Path, pattern, message string) validate.Issue {
	return validate.Issue{
		"origin": "string", "code": "invalid_format", "format": "regex",
		"pattern": pattern, "path": path.Raw(), "message": message,
	}
}

// literalIssue is z.literal(value)'s invalid_value.
func literalIssue(path validate.Path, value string) validate.Issue {
	return validate.Issue{
		"code": "invalid_value", "values": []string{value}, "path": path.Raw(),
		"message": `Invalid input: expected "` + value + `"`,
	}
}

// customIssue is a failed .refine(): zod adds a pathless custom issue.
var customIssue = validate.Issue{"code": "custom", "path": []any{}, "message": "Invalid input"}

// aborts reports an issue that stops a later .refine() from running: zod's
// invalid_type and invalid_value carry continue:false, while too_small,
// too_big and invalid_format continue the pipeline.
func aborts(issues []validate.Issue) bool {
	for _, issue := range issues {
		switch issue["code"] {
		case "invalid_type", "invalid_value":
			return true
		}
	}
	return false
}

// nonSpace is JS /^\S+$/: no character of ECMAScript's \s class anywhere (the
// anchors are strict; `$` does not accept a trailing newline).
func nonSpace(text string) bool {
	if text == "" {
		return false
	}
	for _, character := range text {
		if validate.IsJSSpace(character) {
			return false
		}
	}
	return true
}

// hexToken is JS /^[a-fA-F0-9]{64,200}$/.
func hexToken(text string) bool {
	if len(text) < 64 || len(text) > 200 {
		return false
	}
	for _, character := range text {
		switch {
		case character >= '0' && character <= '9',
			character >= 'a' && character <= 'f',
			character >= 'A' && character <= 'F':
		default:
			return false
		}
	}
	return true
}

// jsTruthy is JavaScript truthiness for a decoded JSON value.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case validate.Object:
		return true
	case *validate.Object:
		return true
	case []any:
		return true
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		number, err := typed.Float64()
		return err != nil || (number != 0 && !math.IsNaN(number))
	}
	// validate.Undefined (an absent key) is the only other value the decoder
	// produces.
	return false
}

// strictString is `.min(n).max(n)` counting code points, as zod 4 does, then a
// regex check that still runs when a length check already failed
// (validate.String omits that ordering because its callers use plain bounds).
func strictString(path validate.Path, raw any, minimum, maximum int, pattern, message string) (string, []validate.Issue) {
	text, issues := validate.String(path, raw, validate.StringRules{Min: minimum, Max: maximum})
	if value, ok := raw.(string); ok && !patternHolds(pattern, value) {
		issues = append(issues, regexIssue(path, pattern, message))
	}
	return text, issues
}

// patternHolds applies one of the two hand-written patterns above.
func patternHolds(pattern, value string) bool {
	switch pattern {
	case tokenPatternSource:
		return nonSpace(value)
	case voipPatternSource:
		return hexToken(value)
	}
	return true
}

// ParseRegister validates notifications.registerPush's input.
func ParseRegister(input orpc.Input) (RegisterInput, *orpc.Error) {
	object, issues := validate.Decode(input.Raw, nil)
	if issues != nil {
		return RegisterInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	token, tokenIssues := strictString(validate.Path{"token"}, object.Field("token"), 8, 512,
		tokenPatternSource, "Invalid string: must match pattern "+tokenPatternSource)
	found = append(found, tokenIssues...)
	presentation := ""
	if value, present := object.Get("presentation"); present {
		if text, ok := value.(string); !ok || text != "android_sender" {
			found = append(found, literalIssue(validate.Path{"presentation"}, "android_sender"))
		} else {
			presentation = text
		}
	}
	if found != nil {
		return RegisterInput{}, validate.Fail(found)
	}
	return RegisterInput{Token: validate.JSTrim(token), Presentation: presentation}, nil
}

// ParseCall validates notifications.registerCallPush's input, including the
// object-level refinement: at least an Expo token, or a VoIP token on iOS.
func ParseCall(input orpc.Input) (CallInput, *orpc.Error) {
	object, issues := validate.Decode(input.Raw, nil)
	if issues != nil {
		return CallInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	parsed := CallInput{}
	deviceRaw := object.Field("deviceId")
	if text, ok := deviceRaw.(string); ok {
		parsed.DeviceID = text
		if !uuidPattern.MatchString(text) {
			found = append(found, validate.Issue{
				"origin": "string", "code": "invalid_format", "format": "uuid",
				"pattern": uuidPatternSource, "path": validate.Path{"deviceId"}.Raw(),
				"message": "Invalid UUID",
			})
		}
	} else {
		found = append(found, validate.TypeIssue("string", validate.JSType(deviceRaw), validate.Path{"deviceId"}))
	}
	if platform, platformIssues := validate.Enum(validate.Path{"platform"}, object.Field("platform"), "ios", "android"); platformIssues != nil {
		found = append(found, platformIssues...)
	} else {
		parsed.Platform = platform
	}
	if value, present := object.Get("expoToken"); present {
		token, tokenIssues := strictString(validate.Path{"expoToken"}, value, 8, 512,
			tokenPatternSource, "Invalid string: must match pattern "+tokenPatternSource)
		found = append(found, tokenIssues...)
		parsed.ExpoToken, parsed.HasExpo = token, tokenIssues == nil
	}
	if value, present := object.Get("voipToken"); present {
		token, tokenIssues := strictString(validate.Path{"voipToken"}, value, 0, 0,
			voipPatternSource, "Invalid string: must match pattern "+voipPatternSource)
		found = append(found, tokenIssues...)
		parsed.VoipToken, parsed.HasVoip = token, tokenIssues == nil
	}
	if !aborts(found) {
		// The refinement reads the raw input (zod applies it to the input value,
		// so a field that failed its own check still contributes its sent value).
		expo, _ := object.Get("expoToken")
		voip, _ := object.Get("voipToken")
		platform, _ := object.Get("platform")
		ios, _ := platform.(string)
		if !jsTruthy(expo) && !(ios == "ios" && jsTruthy(voip)) {
			found = append(found, customIssue)
		}
	}
	if found != nil {
		return CallInput{}, validate.Fail(found)
	}
	return parsed, nil
}
