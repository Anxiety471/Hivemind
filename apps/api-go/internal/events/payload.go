package events

import (
	"errors"
	"unicode"
)

// responseBlockKinds is RESPONSE_BLOCK_KINDS: blocks that count as reply
// output (packages/db/src/run-timing.ts:4-24).
var responseBlockKinds = map[string]bool{
	"card": true, "chart": true, "app": true, "ask": true, "choice": true,
	"app_connect": true, "connect": true, "computer": true, "voice_call": true,
	"call_request": true, "image": true, "file": true, "page": true, "handoff": true,
	"skill_draft": true, "mcp_approval": true, "child_bot": true, "cloud_agent": true,
}

// IsRunResponse is isRunResponse: only actual reply output counts, working and
// activity placeholders do not (run-timing.ts:26-42).
func IsRunResponse(eventType string, payload map[string]any) bool {
	if eventType == "thread.progress" {
		if streaming, _ := payload["streaming"].(bool); !streaming {
			return false
		}
		// `payload.activity !== true`: only the boolean true is excluded.
		if activity, ok := payload["activity"].(bool); ok && activity {
			return false
		}
		for _, key := range []string{"text", "delta"} {
			if text, ok := payload[key].(string); ok && !jsTrimmedEmpty(text) {
				return true
			}
		}
		return false
	}
	if eventType != "thread.message.created" {
		return false
	}
	if role, _ := payload["role"].(string); role != "bot" {
		return false
	}
	blocks, ok := payload["blocks"].([]any)
	if !ok {
		return false
	}
	for _, item := range blocks {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, ok := block["kind"].(string)
		if !ok {
			continue
		}
		if kind == "text" {
			if text, ok := block["text"].(string); ok && !jsTrimmedEmpty(text) {
				return true
			}
			continue
		}
		if responseBlockKinds[kind] {
			return true
		}
	}
	return false
}

// isActivityEvent is isActivityEvent (events.ts:996-1002): a thinking marker
// comes only from the run's current lease holder, and the payload must be
// exactly ThreadActivityPayloadSchema. A schema violation is an ordinary error
// like the ZodError TS throws; callers turn it into the same 500.
func isActivityEvent(input Input) (bool, error) {
	if input.Type != "thread.meta" {
		return false, nil
	}
	activity, ok := input.Payload["activity"]
	if !ok {
		return false, nil
	}
	record, ok := activity.(map[string]any)
	if !ok {
		return false, nil
	}
	if _, ok := record["thinking"]; !ok {
		return false, nil
	}
	if len(input.Payload) != 1 || len(record) != 1 {
		return false, errors.New("Invalid thread activity payload")
	}
	if _, ok := record["thinking"].(bool); !ok {
		return false, errors.New("Invalid thread activity payload")
	}
	if input.RunID == "" || input.Lease == nil {
		return false, ErrRunHistoryWrite
	}
	return true, nil
}

// jsTrimmedEmpty is `value.trim().length === 0` with ECMAScript's whitespace
// set: WhiteSpace (including U+FEFF) and LineTerminators, but not U+0085,
// which unicode.IsSpace would also trim.
func jsTrimmedEmpty(value string) bool {
	for _, char := range value {
		if !isECMAScriptSpace(char) {
			return false
		}
	}
	return true
}

func isECMAScriptSpace(char rune) bool {
	switch char {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, // no-break space
		0x1680, // ogham space mark
		0x2028, // line separator
		0x2029, // paragraph separator
		0x202F, // narrow no-break space
		0x205F, // medium mathematical space
		0x3000, // ideographic space
		0xFEFF: // zero width no-break space
		return true
	}
	return char >= 0x2000 && char <= 0x200A && unicode.Is(unicode.Zs, char)
}
