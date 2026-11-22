package routines

// Skill-reference expansion for routines.testRun, ported from
// packages/core/src/skills/agent-skill.ts and agent-skill.prompt.ts. Routine
// prompts may force a skill (`/Name` or `Use skill: Name`) or mention skills
// (`@Name`); the test run expands them into skill bodies exactly as the
// TypeScript fire-time expansion does, and stays idempotent when the routine's
// prompt was already expanded.
//
// The TypeScript patterns use a lookbehind-style `(?:^|lead)` and a lookahead
// for the closing boundary. Go's RE2 has no lookaround, so mentions are located
// as plain `@Name` spans and their surroundings are checked with rune
// predicates, which is what those groups express.

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentskills"
)

var (
	forcedSkillPrefix = regexp.MustCompile(`(?i)^(?:/|use\s+skill:\s*)([^\n]*)`)
	settingsName      = regexp.MustCompile(`(?i)^(chat\s+settings|settings:)`)
)

var routineSkillStop = map[string]bool{
	"then": true, "and": true, "or": true, "to": true, "for": true,
	"with": true, "from": true, "via": true, "before": true, "after": true,
	"please": true, "the": true, "a": true, "an": true,
}

// jsSpace is JavaScript's \s, which trimStart uses.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func trimStart(text string) string { return strings.TrimLeftFunc(text, jsSpace) }

func isBlank(r byte) bool { return r == ' ' || r == '\t' }

// isLead is ROUTINE_SKILL_LEAD: whitespace, `(` and the CJK openers.
func isLead(r rune) bool {
	if unicode.IsSpace(r) {
		return true
	}
	switch r {
	case '(', '（', '【', '「', '『', '《':
		return true
	}
	return false
}

// isBoundary is ROUTINE_SKILL_END's lookahead set.
func isBoundary(r rune) bool {
	if unicode.IsSpace(r) {
		return true
	}
	switch r {
	case ',', '.', ')', '，', '。', '、', '；', '：', '！', '？', '）', '】', '」', '』', '》':
		return true
	}
	return false
}

// mentionAt reports whether prompt[index] starts a mention: `@` with a lead rune
// (or the start) before it.
func mentionAt(prompt string, index int) bool {
	if index < 0 || index >= len(prompt) || prompt[index] != '@' {
		return false
	}
	if index == 0 {
		return true
	}
	before, _ := utf8.DecodeLastRuneInString(prompt[:index])
	return isLead(before)
}

// boundaryAfter reports whether the rune at index closes a mention (or the text ends).
func boundaryAfter(prompt string, index int) bool {
	if index >= len(prompt) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(prompt[index:])
	return isBoundary(r)
}

// extractForcedSkillName is extractForcedSkillName: a `/Name` or `Use skill: Name`
// prefix, the name, and the rest of the prompt.
func extractForcedSkillName(prompt string) (name, rest string, ok bool) {
	text := trimStart(prompt)
	match := forcedSkillPrefix.FindStringSubmatch(text)
	if match == nil {
		return "", "", false
	}
	name = strings.TrimSpace(match[1])
	name = strings.TrimLeft(name, "/")
	name = strings.TrimSpace(name)
	if name == "" || len(unitsOf(name)) > 80 {
		return "", "", false
	}
	if settingsName.MatchString(name) {
		return "", "", false
	}
	return name, trimStart(text[len(match[0]):]), true
}

// formatForcedSkillPrompt is formatForcedSkillPrompt (agent-skill.prompt.ts:20).
func formatForcedSkillPrompt(name, content, rest string) string {
	parts := []string{"Use skill: " + name, "", strings.TrimSpace(content)}
	if trailing := strings.TrimSpace(rest); trailing != "" {
		parts = append(parts, "", trailing)
	}
	return strings.Join(parts, "\n")
}

// restAlreadyIncludesSkillContent is restAlreadyIncludesSkillContent: a prior
// expansion pass already put the body in the prompt.
func restAlreadyIncludesSkillContent(rest, content string) bool {
	trimmedRest := strings.TrimSpace(rest)
	trimmedContent := strings.TrimSpace(content)
	if trimmedContent == "" {
		return false
	}
	return trimmedRest == trimmedContent ||
		strings.HasPrefix(trimmedRest, trimmedContent+"\n") ||
		strings.HasPrefix(trimmedRest, trimmedContent+"\r\n")
}

func findSkill(skills []agentskills.Skill, name string) *agentskills.Skill {
	needle := strings.ToLower(strings.TrimSpace(name))
	if needle == "" {
		return nil
	}
	for index := range skills {
		if strings.ToLower(strings.TrimSpace(skills[index].Name)) == needle {
			return &skills[index]
		}
	}
	return nil
}

func hasPrefixFold(text, prefix string) bool {
	return len(text) >= len(prefix) && strings.EqualFold(text[:len(prefix)], prefix)
}

// extractRoutineSkillMentions is extractRoutineSkillMentions: unique `@Name`
// mentions, returned in the longest-name-first order the TS catalog match uses.
func extractRoutineSkillMentions(prompt string, knownNames []string) []string {
	if len(knownNames) > 0 {
		sorted := make([]string, 0, len(knownNames))
		for _, name := range knownNames {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				sorted = append(sorted, trimmed)
			}
		}
		// Longest first, so `@Daily standup` never resolves as `@Daily`.
		for left := 0; left < len(sorted); left++ {
			for right := left + 1; right < len(sorted); right++ {
				if len(unitsOf(sorted[right])) > len(unitsOf(sorted[left])) {
					sorted[left], sorted[right] = sorted[right], sorted[left]
				}
			}
		}
		if len(sorted) == 0 {
			return nil
		}
		matched := map[string]bool{}
		for index := 0; index < len(prompt); index++ {
			if !mentionAt(prompt, index) {
				continue
			}
			for _, name := range sorted {
				if !hasPrefixFold(prompt[index+1:], name) {
					continue
				}
				end := index + 1 + len(name)
				if !boundaryAfter(prompt, end) {
					continue
				}
				matched[strings.ToLower(name)] = true
				index = end - 1
				break
			}
		}
		found := make([]string, 0, len(matched))
		for _, name := range sorted {
			if matched[strings.ToLower(name)] {
				matched[strings.ToLower(name)] = false
				found = append(found, name)
			}
		}
		return found
	}

	var names []string
	seen := map[string]bool{}
	for index := 0; index < len(prompt); index++ {
		if !mentionAt(prompt, index) {
			continue
		}
		end := index + 1
		words := 0
		for {
			wordStart := end
			for end < len(prompt) && isWordRune(prompt[end], end == wordStart) {
				end++
			}
			if end == wordStart {
				break
			}
			words++
			if words >= 6 || end >= len(prompt) || prompt[end] != ' ' {
				break
			}
			next := end
			for next < len(prompt) && prompt[next] == ' ' {
				next++
			}
			if next >= len(prompt) || !isLetter(prompt[next]) {
				break
			}
			end = next
		}
		if words == 0 || !boundaryAfter(prompt, end) {
			continue
		}
		parts := strings.Fields(prompt[index+1 : end])
		for len(parts) > 1 && routineSkillStop[strings.ToLower(parts[len(parts)-1])] {
			parts = parts[:len(parts)-1]
		}
		name := strings.TrimSpace(strings.Join(parts, " "))
		if name == "" || strings.ToLower(name) == "everyone" {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		names = append(names, name)
		index = end - 1
	}
	return names
}

func isLetter(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

func isWordRune(ch byte, first bool) bool {
	if isLetter(ch) {
		return true
	}
	if first {
		return false
	}
	return (ch >= '0' && ch <= '9') || ch == '_' || ch == '-'
}

// stripRoutineSkillMention is stripRoutineSkillMention: remove `@Name` tokens
// (and adjacent repeats sharing separators) with the whitespace seam cleanup.
func stripRoutineSkillMention(prompt, name string) string {
	var parts []string
	cursor := 0
	for index := 0; index < len(prompt); index++ {
		if !mentionAt(prompt, index) || !hasPrefixFold(prompt[index+1:], name) {
			continue
		}
		start := index
		end := index + 1 + len(name)
		// Consume adjacent repeats: `@Name @Name` is one seam.
		for {
			blank := end
			for blank < len(prompt) && isBlank(prompt[blank]) {
				blank++
			}
			if blank == end || blank >= len(prompt) || prompt[blank] != '@' ||
				!hasPrefixFold(prompt[blank+1:], name) {
				break
			}
			end = blank + 1 + len(name)
		}
		if !boundaryAfter(prompt, end) {
			continue
		}
		left := start
		for left > cursor && isBlank(prompt[left-1]) {
			left--
		}
		right := end
		for right < len(prompt) && isBlank(prompt[right]) {
			right++
		}
		before := prompt[left:start]
		after := prompt[end:right]
		hasLeftText := left > 0 && prompt[left-1] != '\n' && prompt[left-1] != '\r'
		hasRightText := right < len(prompt) && prompt[right] != '\n' && prompt[right] != '\r'
		separator := ""
		if hasRightText {
			if hasLeftText {
				if before != "" && after != "" {
					separator = " "
				} else if before != "" {
					separator = before
				} else {
					separator = after
				}
			} else {
				separator = before
			}
		}
		parts = append(parts, prompt[cursor:left], separator)
		cursor = right
		index = right - 1
	}
	parts = append(parts, prompt[cursor:])
	return strings.Join(parts, "")
}

// expandSkillReferencesInPrompt is expandSkillReferencesInPrompt: a forced
// skill wins; otherwise every known `@Name` mention becomes a body block and
// the mention tokens are stripped from what remains.
func expandSkillReferencesInPrompt(prompt string, skills []agentskills.Skill) string {
	if name, rest, ok := extractForcedSkillName(prompt); ok {
		if skill := findSkill(skills, name); skill != nil {
			if restAlreadyIncludesSkillContent(rest, skill.Content) {
				return trimStart(prompt)
			}
			return formatForcedSkillPrompt(skill.Name, skill.Content, rest)
		}
	}
	names := make([]string, 0, len(skills))
	for _, skill := range skills {
		names = append(names, skill.Name)
	}
	mentions := extractRoutineSkillMentions(prompt, names)
	if len(mentions) == 0 {
		return prompt
	}
	var blocks []string
	remaining := prompt
	for _, mention := range mentions {
		skill := findSkill(skills, mention)
		if skill == nil {
			continue
		}
		blocks = append(blocks, formatForcedSkillPrompt(skill.Name, skill.Content, ""))
		remaining = stripRoutineSkillMention(remaining, mention)
	}
	if len(blocks) == 0 {
		return prompt
	}
	parts := make([]string, 0, len(blocks)+1)
	for _, part := range append(blocks, remaining) {
		if strings.TrimSpace(part) != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "\n\n")
}
