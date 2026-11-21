package taskdetect

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode"
)

const (
	titleMaxLen       = 200
	descriptionMaxLen = 20_000
	// duplicateThreshold is the minimum Jaccard token overlap for treating a
	// newly detected task as a duplicate of an existing open ticket.
	duplicateThreshold = 0.75
)

var (
	eligibleTriggers = map[string]bool{
		"user":        true,
		"messaging":   true,
		"follow_up":   true,
		"bot_message": true,
	}
	validActionStatuses = map[string]bool{
		"todo":    true,
		"doing":   true,
		"review":  true,
		"blocked": true,
		"done":    true,
	}
	validPriorities = map[string]bool{
		"low":    true,
		"normal": true,
		"high":   true,
		"urgent": true,
	}
	// trivialReplies are short acknowledgements/greetings that never justify an
	// extraction LLM call when no tools ran and no open tickets exist.
	trivialPrompts = map[string]bool{
		"hi": true, "hello": true, "hey": true, "yo": true, "sup": true,
		"ok": true, "okay": true, "k": true, "kk": true, "yes": true, "no": true,
		"yep": true, "nope": true, "sure": true, "thanks": true, "thank you": true,
		"thx": true, "ty": true, "cool": true, "great": true, "nice": true,
		"got it": true, "sounds good": true, "bye": true, "goodbye": true,
		"good morning": true, "good night": true, "gm": true, "gn": true,
	}
	stopWords = map[string]bool{
		"a": true, "an": true, "the": true, "to": true, "for": true,
		"of": true, "on": true, "in": true, "and": true, "or": true,
		"with": true, "from": true, "into": true, "up": true, "about": true,
	}
)

// TriggerEligible reports whether a run trigger represents a conversational turn
// that can introduce or advance tasks (routines, ticket wakes, creation intros,
// and background helpers are excluded).
func TriggerEligible(trigger string) bool {
	return eligibleTriggers[strings.TrimSpace(trigger)]
}

// ShouldInspect decides whether a completed turn warrants an LLM extraction call.
// Trivial greetings/acks without tool activity and without open tickets are skipped
// to avoid unnecessary model calls on casual chat.
func ShouldInspect(trigger, userText, assistantText string, usedTools bool, openTicketCount int) (bool, string) {
	if !TriggerEligible(trigger) {
		return false, "ineligible_trigger"
	}
	trimmedUser := strings.TrimSpace(userText)
	trimmedReply := strings.TrimSpace(assistantText)
	if trimmedUser == "" && trimmedReply == "" {
		return false, "empty_turn"
	}
	if !usedTools && openTicketCount == 0 {
		normalized := NormalizeTitle(trimmedUser)
		if normalized == "" || trivialPrompts[normalized] {
			return false, "trivial_message"
		}
		if len([]rune(normalized)) < 12 && len(strings.Fields(normalized)) <= 2 {
			return false, "too_short"
		}
	}
	return true, ""
}

type rawEnvelope struct {
	Actions []Action `json:"actions"`
}

// ParseModelOutput extracts and validates task actions from an LLM response.
// Accepts raw JSON, markdown-fenced JSON, or a JSON object embedded in prose.
func ParseModelOutput(raw string) ([]Action, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	jsonText := extractJSONObject(trimmed)
	if jsonText == "" {
		return nil, errors.New("no JSON object found in model output")
	}
	var envelope rawEnvelope
	if err := json.Unmarshal([]byte(jsonText), &envelope); err != nil {
		return nil, err
	}
	return SanitizeActions(envelope.Actions), nil
}

// SanitizeActions validates, normalizes, and bounds extracted actions.
func SanitizeActions(actions []Action) []Action {
	if len(actions) == 0 {
		return nil
	}
	out := make([]Action, 0, min(len(actions), MaxActionsPerTurn))
	for _, action := range actions {
		if len(out) >= MaxActionsPerTurn {
			break
		}
		op := strings.ToLower(strings.TrimSpace(action.Op))
		if op != "create" && op != "update" {
			continue
		}
		title := sanitizeText(action.Title, titleMaxLen)
		var description *string
		if action.Description != nil {
			cleaned := sanitizeText(*action.Description, descriptionMaxLen)
			if cleaned != "" {
				description = &cleaned
			}
		}
		status := strings.ToLower(strings.TrimSpace(action.Status))
		if status != "" && !validActionStatuses[status] {
			status = ""
		}
		priority := strings.ToLower(strings.TrimSpace(action.Priority))
		if priority != "" && !validPriorities[priority] {
			priority = ""
		}
		ticketID := strings.TrimSpace(action.TicketID)
		ref := strings.ToUpper(strings.TrimSpace(action.Ref))

		if op == "create" {
			if title == "" {
				continue
			}
			if status == "" {
				status = "todo"
			}
			if priority == "" {
				priority = "normal"
			}
			out = append(out, Action{
				Op:          "create",
				Title:       title,
				Description: description,
				Status:      status,
				Priority:    priority,
			})
			continue
		}

		// op == "update"
		if ticketID == "" && ref == "" {
			continue
		}
		if title == "" && description == nil && status == "" && priority == "" {
			continue
		}
		out = append(out, Action{
			Op:          "update",
			TicketID:    ticketID,
			Ref:         ref,
			Title:       title,
			Description: description,
			Status:      status,
			Priority:    priority,
		})
	}
	return out
}

// NormalizeTitle lowercases, replaces punctuation with spaces, and collapses whitespace.
func NormalizeTitle(title string) string {
	var b strings.Builder
	b.Grow(len(title))
	prevSpace := true
	for _, r := range strings.ToLower(title) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevSpace = false
			continue
		}
		if !prevSpace {
			b.WriteByte(' ')
			prevSpace = true
		}
	}
	return strings.TrimSpace(b.String())
}

// FindDuplicate returns the existing open ticket matching a proposed title, if any.
// Matches either exact normalized title or high token Jaccard overlap for multi-word titles.
func FindDuplicate(title string, existing []OpenTicket) (OpenTicket, bool) {
	targetNorm := NormalizeTitle(title)
	if targetNorm == "" {
		return OpenTicket{}, false
	}
	targetTokens := significantTokens(targetNorm)

	var best OpenTicket
	var bestScore float64
	for _, ticket := range existing {
		norm := NormalizeTitle(ticket.Title)
		if norm == "" {
			continue
		}
		if norm == targetNorm {
			return ticket, true
		}
		if len(targetTokens) < 2 {
			continue
		}
		otherTokens := significantTokens(norm)
		if len(otherTokens) < 2 {
			continue
		}
		score := jaccard(targetTokens, otherTokens)
		if score >= duplicateThreshold && score > bestScore {
			best = ticket
			bestScore = score
		}
	}
	if bestScore >= duplicateThreshold {
		return best, true
	}
	return OpenTicket{}, false
}

func significantTokens(normalized string) map[string]struct{} {
	fields := strings.Fields(normalized)
	tokens := make(map[string]struct{}, len(fields))
	for _, word := range fields {
		if stopWords[word] {
			continue
		}
		tokens[word] = struct{}{}
	}
	if len(tokens) == 0 {
		for _, word := range fields {
			tokens[word] = struct{}{}
		}
	}
	return tokens
}

func jaccard(a, b map[string]struct{}) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	intersection := 0
	for k := range a {
		if _, ok := b[k]; ok {
			intersection++
		}
	}
	union := len(a) + len(b) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func sanitizeText(value string, maxRunes int) string {
	cleaned := strings.ReplaceAll(strings.TrimSpace(value), "\x00", "\uFFFD")
	runes := []rune(cleaned)
	if len(runes) <= maxRunes {
		return cleaned
	}
	return strings.TrimSpace(string(runes[:maxRunes]))
}

// extractJSONObject strips optional markdown code fences and returns the first
// balanced JSON object slice in raw, or empty if none is found.
func extractJSONObject(raw string) string {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "```") {
		if nl := strings.IndexByte(text, '\n'); nl >= 0 {
			text = text[nl+1:]
		}
		if end := strings.LastIndex(text, "```"); end >= 0 {
			text = text[:end]
		}
		text = strings.TrimSpace(text)
	}
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(text); i++ {
		ch := text[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start : i+1]
			}
		}
	}
	return ""
}
