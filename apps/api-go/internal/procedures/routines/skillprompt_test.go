package routines

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentskills"
)

func TestExpandSkillReferencesInPrompt(t *testing.T) {
	skills := []agentskills.Skill{
		{Name: "Alpha", Content: "ALPHA BODY"},
		{Name: "Daily standup", Content: "STANDUP BODY"},
	}
	// A forced /Name prefix becomes `Use skill:` with the body and the rest.
	// The composer forces `/Name` on its own line; the rest is the request.
	got := expandSkillReferencesInPrompt("/Alpha\nwrite the report", skills)
	want := "Use skill: Alpha\n\nALPHA BODY\n\nwrite the report"
	if got != want {
		t.Fatalf("forced expansion = %q, want %q", got, want)
	}
	// Expanding an already-expanded prompt is idempotent (the body is the rest).
	expanded := "Use skill: Alpha\n\nALPHA BODY\n\nwrite the report"
	if counter := expandSkillReferencesInPrompt(expanded, skills); counter != trimStart(expanded) {
		t.Fatalf("second expansion = %q", counter)
	}
	// A mention becomes a block and the token is stripped from what remains.
	got = expandSkillReferencesInPrompt("@Daily standup then post", skills)
	want = "Use skill: Daily standup\n\nSTANDUP BODY\n\nthen post"
	if got != want {
		t.Fatalf("mention expansion = %q, want %q", got, want)
	}
	// Unknown mentions and /settings actions are left alone.
	for _, prompt := range []string{"@everyone hi", "/settings: general", "no skills here"} {
		if got := expandSkillReferencesInPrompt(prompt, skills); got != prompt {
			t.Errorf("expansion of %q = %q", prompt, got)
		}
	}
	// A forced name that is not in the catalog falls through to mentions.
	got = expandSkillReferencesInPrompt("/Missing\n@Alpha go", skills)
	want = "Use skill: Alpha\n\nALPHA BODY\n\n/Missing\ngo"
	if got != want {
		t.Fatalf("fallthrough expansion = %q, want %q", got, want)
	}
}
