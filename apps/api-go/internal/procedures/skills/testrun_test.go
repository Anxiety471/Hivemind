package skills

import (
	"strings"
	"testing"
)

func testPlaybook() Playbook {
	return Playbook{
		WhenToUse:          "When a client asks for an invoice.",
		Inputs:             []string{"client name", "amount"},
		Steps:              []string{"Open the client page.", "Click New invoice.", "Fill the form."},
		HowToCheck:         "The invoice appears in the list.",
		WhatToReturn:       "The invoice link.",
		ApprovalBoundaries: "Ask before sending anything.",
		FailureHandling:    "Stop and ask the user.",
	}
}

func TestFormatSkillRunPromptRendersEverySection(t *testing.T) {
	want := `Run taught skill: Send invoice
This is a safe test run. Do not send, spend, delete, or publish anything.
When to use: When a client asks for an invoice.
Inputs: client name; amount
Steps:
1. Open the client page.
2. Click New invoice.
3. Fill the form.
How to check: The invoice appears in the list.
Return: The invoice link.
Approval boundaries: Ask before sending anything.
Failure handling: Stop and ask the user.`
	if got := formatSkillRunPrompt("Send invoice", testPlaybook(), true); got != want {
		t.Fatalf("prompt =\n%s\nwant\n%s", got, want)
	}
	// A real run (not a trial) carries no safety line, but every other section stays.
	real := formatSkillRunPrompt("Send invoice", testPlaybook(), false)
	if strings.Contains(real, "safe test run") {
		t.Fatalf("a real run has no safety line:\n%s", real)
	}
	if !strings.HasPrefix(real, "Run taught skill: Send invoice\nWhen to use: When a client asks for an invoice.\n") {
		t.Fatalf("real prompt =\n%s", real)
	}
}

func TestFormatSkillRunPromptDropsEmptyInputs(t *testing.T) {
	playbook := Playbook{}
	// An empty value keeps its prefixed line (the template always writes it), while the Inputs
	// line exists only for a non-empty list and the safety line only for a trial run.
	want := "Run taught skill: Empty\n" +
		"When to use: \n" +
		"Steps:\n" +
		"How to check: \n" +
		"Return: \n" +
		"Approval boundaries: \n" +
		"Failure handling: "
	if got := formatSkillRunPrompt("Empty", playbook, false); got != want {
		t.Fatalf("prompt = %q want %q", got, want)
	}
	if got := formatSkillRunPrompt("Empty", playbook, true); !strings.HasPrefix(got,
		"Run taught skill: Empty\nThis is a safe test run. Do not send, spend, delete, or publish anything.\n") {
		t.Fatalf("trial prompt = %q", got)
	}
	if strings.Contains(formatSkillRunPrompt("Empty", playbook, true), "Inputs:") {
		t.Fatal("an empty inputs list writes no Inputs line")
	}
	// One input does not need a separator, and the separator is "; " exactly.
	one := Playbook{Inputs: []string{"client name"}}
	if got := formatSkillRunPrompt("One", one, false); !strings.Contains(got, "\nInputs: client name\n") {
		t.Fatalf("prompt = %q", got)
	}
}

func TestSkillTaskPromptFallsBackToTheSlicedGoal(t *testing.T) {
	goal := strings.Repeat("g", 90)
	first := func(prompt string) string {
		return strings.SplitN(prompt, "\n", 2)[0]
	}
	got := skillTaskPrompt(row{Goal: goal}, nil)
	if line := first(got); line != "Run taught skill: "+strings.Repeat("g", 80) {
		t.Fatalf("fallback title = %q", line)
	}
	// The stored playbook is what the prompt renders; a skill without one uses the defaults.
	if !strings.Contains(got, "\nWhen to use: "+defaultWhenToUse+"\n") {
		t.Fatalf("prompt = %q", got)
	}
	if !strings.Contains(got, "\nThis is a safe test run.") {
		t.Fatalf("a testRun prompt carries the safety line: %q", got)
	}

	// A name wins over the goal entirely.
	named := skillTaskPrompt(row{Name: "Send invoice", Goal: goal}, nil)
	if line := first(named); line != "Run taught skill: Send invoice" {
		t.Fatalf("named title = %q", line)
	}

	// skill.goal.slice(0, 80) counts UTF-16 units: 50 astral characters are 100 units, so the
	// fallback keeps 40 characters.
	emoji := strings.Repeat("😀", 50)
	if line := first(skillTaskPrompt(row{Goal: emoji}, nil)); line != "Run taught skill: "+strings.Repeat("😀", 40) {
		t.Fatalf("astral title = %q", line)
	}
	// A cut through a pair leaves a lone half, and the write hook's sanitizer answers U+FFFD:
	// 79 ASCII units then an astral character, whose high half is the 80th unit.
	cut := strings.Repeat("a", 79) + "😀"
	if line := first(skillTaskPrompt(row{Goal: cut}, nil)); line != "Run taught skill: "+strings.Repeat("a", 79)+"\uFFFD" {
		t.Fatalf("cut title = %q", line)
	}
}

func TestSkillTaskPromptKeepsAnExplicitEmptyPrompt(t *testing.T) {
	empty := ""
	got := skillTaskPrompt(row{Name: "Send invoice"}, &empty)
	if got != "" {
		t.Fatalf("an explicit empty prompt is the prompt: %q", got)
	}
	// formatSkillRunPrompt always answers a non-empty prompt, so the empty result proves the
	// formatter was not reached.
	if formatted := formatSkillRunPrompt("Send invoice", defaultPlaybook(), true); formatted == "" {
		t.Fatal("the formatter cannot answer an empty prompt")
	}
	// A prompt the caller sent wins even when the skill has a playbook to render.
	explicit := "Use the other client."
	if got := skillTaskPrompt(row{Name: "Send invoice", Playbook: playbookValue(testPlaybook())}, &explicit); got != explicit {
		t.Fatalf("explicit prompt = %q", got)
	}
}

func TestParseTestRunReadsTheOptionalPrompt(t *testing.T) {
	// Absent prompt: no prompt, so the skill's playbook is rendered.
	absent, failure := parseTestRun(input(`{"skillId":"skill-1"}`))
	if failure != nil || absent.SkillID != "skill-1" || absent.Prompt != nil {
		t.Fatalf("absent = %+v %v", absent, failure)
	}
	// An explicit empty string is a prompt, not a missing one.
	present, failure := parseTestRun(input(`{"skillId":"skill-1","prompt":""}`))
	if failure != nil || present.Prompt == nil || *present.Prompt != "" {
		t.Fatalf("empty = %+v %v", present.Prompt, failure)
	}
	text, failure := parseTestRun(input(`{"skillId":"skill-1","prompt":"Do it now"}`))
	if failure != nil || text.Prompt == nil || *text.Prompt != "Do it now" {
		t.Fatalf("text = %+v %v", text.Prompt, failure)
	}
}

func TestParseTestRunRefusesWhatTheSchemaRefuses(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`[]`,
		`{"skillId":""}`,
		`{"skillId":7}`,
		`{"prompt":"x"}`,
		`{"skillId":"skill-1","prompt":null}`,
		`{"skillId":"skill-1","prompt":7}`,
		`{"skillId":"skill-1","prompt":[]}`,
	} {
		if _, failure := parseTestRun(input(body)); failure == nil || failure.Code != "BAD_REQUEST" {
			t.Fatalf("%s: failure = %v", body, failure)
		}
	}
}
