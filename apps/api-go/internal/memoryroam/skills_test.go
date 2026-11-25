package memoryroam

import (
	"strings"
	"testing"
)

func writableSkill(name, content string) skillRecord {
	return skillRecord{ID: "id-" + name, Name: name, Description: "desc", Content: content, Writable: true}
}

func TestSkillUpdateKeepsFrontmatterAndReplacesTheBody(t *testing.T) {
	existing := "---\nname: Deploy\ndescription: Ship it\nlicense: MIT\n---\n\n1. old step\n"
	skill := writableSkill("Deploy", existing)
	plan, err := validateSkillCommands(answer{Commands: []command{
		{Name: CmdSkillUpdate, Skill: "deploy", Body: "1. new step\n2. verify\n"},
	}}, []skillRecord{skill}, []skillRecord{skill})
	if err != nil {
		t.Fatalf("validateSkillCommands: %v", err)
	}
	want := "---\nname: Deploy\ndescription: Ship it\nlicense: MIT\n---\n\n1. new step\n2. verify\n"
	if len(plan.Updates) != 1 || plan.Updates[0].Content != want || plan.Updates[0].Current.ID != skill.ID {
		t.Fatalf("updates = %+v", plan.Updates)
	}
}

func TestSkillUpdateOfAnUnchangedBodyIsDropped(t *testing.T) {
	skill := writableSkill("Deploy", "---\nname: Deploy\ndescription: d\n---\n\n1. step\n")
	plan, err := validateSkillCommands(answer{Commands: []command{
		{Name: CmdSkillUpdate, Skill: "Deploy", Body: "1. step"},
	}}, []skillRecord{skill}, []skillRecord{skill})
	if err != nil || len(plan.Updates) != 0 || len(plan.Ignored) != 0 {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
}

func TestSkillCommandsNeverTouchReadOnlySkills(t *testing.T) {
	shared := skillRecord{ID: "s1", Name: "Shared", Description: "d", Content: "---\nname: Shared\ndescription: d\n---\n\nx\n"}
	everywhere := skillRecord{ID: "s2", Name: "Everywhere", Description: "d", Content: "---\nname: Everywhere\ndescription: d\n---\n\nx\n"}
	plan, err := validateSkillCommands(answer{Commands: []command{
		{Name: CmdSkillUpdate, Skill: "Shared", Body: "rewritten"},
		{Name: CmdSkillCreate, Skill: "everywhere", Description: "d", Body: "dup"},
		{Name: CmdSkillCreate, Skill: "Tasks", Description: "d", Body: "clashes with a built-in"},
	}}, nil, []skillRecord{shared, everywhere})
	if err != nil {
		t.Fatalf("validateSkillCommands: %v", err)
	}
	if len(plan.Updates) != 0 || len(plan.Creates) != 0 || len(plan.Ignored) != 3 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestSkillCreateBuildsParsableFrontmatter(t *testing.T) {
	plan, err := validateSkillCommands(answer{Commands: []command{
		{Name: CmdSkillCreate, Skill: "Release notes", Description: "When: writing a changelog\nentry", Body: "1. Collect PRs\n"},
	}}, nil, nil)
	if err != nil {
		t.Fatalf("validateSkillCommands: %v", err)
	}
	if len(plan.Creates) != 1 {
		t.Fatalf("creates = %+v", plan.Creates)
	}
	content := plan.Creates[0].Content
	head, body, ok := splitSkill(content)
	if !ok || body != "\n1. Collect PRs\n" {
		t.Fatalf("head=%q body=%q ok=%v", head, body, ok)
	}
	if !strings.Contains(head, "name: Release notes\n") ||
		!strings.Contains(head, `description: "When: writing a changelog entry"`+"\n") {
		t.Fatalf("frontmatter is not valid YAML: %q", head)
	}
}

func TestSkillCommandsAreCapped(t *testing.T) {
	var commands []command
	for index := range maxSkillCommands + 2 {
		commands = append(commands, command{
			Name: CmdSkillCreate, Skill: "Skill " + strings.Repeat("a", index+1), Description: "d", Body: "step",
		})
	}
	plan, err := validateSkillCommands(answer{Commands: commands}, nil, nil)
	if err != nil {
		t.Fatalf("validateSkillCommands: %v", err)
	}
	if len(plan.Creates) != maxSkillCommands || len(plan.Ignored) != 2 {
		t.Fatalf("creates=%d ignored=%v", len(plan.Creates), plan.Ignored)
	}
}

func TestSkillCommandsRefuseOtherPassesCommands(t *testing.T) {
	plan, err := validateSkillCommands(answer{Commands: []command{
		{Name: CmdMemoryWrite, Path: "MEMORY.md", Content: "# x\n"},
		{Name: CmdInstructionsSet, Content: "new"},
	}}, nil, nil)
	if err != nil || len(plan.Creates)+len(plan.Updates) != 0 || len(plan.Ignored) != 2 {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
}

func TestSkillCommandsRejectMalformedAnswers(t *testing.T) {
	skill := writableSkill("Deploy", "---\nname: Deploy\ndescription: d\n---\n\nx\n")
	cases := map[string]answer{
		"bad name":       {Commands: []command{{Name: CmdSkillCreate, Skill: "../x", Description: "d", Body: "b"}}},
		"no name":        {Commands: []command{{Name: CmdSkillCreate, Description: "d", Body: "b"}}},
		"no description": {Commands: []command{{Name: CmdSkillCreate, Skill: "New", Body: "b"}}},
		"empty body":     {Commands: []command{{Name: CmdSkillCreate, Skill: "New", Description: "d", Body: " "}}},
		"blanked skill":  {Commands: []command{{Name: CmdSkillUpdate, Skill: "Deploy", Body: " "}}},
		"two for one": {Commands: []command{
			{Name: CmdSkillUpdate, Skill: "Deploy", Body: "a"},
			{Name: CmdSkillUpdate, Skill: "deploy", Body: "b"},
		}},
		"too large": {Commands: []command{{Name: CmdSkillCreate, Skill: "New", Description: "d", Body: strings.Repeat("x", MaxSkillContentChars)}}},
	}
	for name, parsed := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := validateSkillCommands(parsed, []skillRecord{skill}, []skillRecord{skill}); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestSkillsPromptNeedsEvidenceAndKeepsReadOnlySkillsOut(t *testing.T) {
	skills := []skillRecord{
		writableSkill("Deploy", "---\nname: Deploy\ndescription: d\n---\n\nsteps\n"),
		{ID: "s", Name: "Shared", Description: "everywhere", Content: "SHARED BODY", Writable: false},
	}
	if payload, _ := skillsPrompt("Space", skills, nil, 10_000); payload != "" {
		t.Fatalf("a prompt without evidence would call the model for nothing: %s", payload)
	}
	payload, writable := skillsPrompt("Space", skills, []evidenceDocument{{Label: "Bot MEMORY.md", Content: "# Bot\n\n- ran the deploy\n"}}, 10_000)
	if len(writable) != 1 || writable[0].Name != "Deploy" {
		t.Fatalf("writable = %+v", writable)
	}
	if !strings.Contains(payload, "- Shared: everywhere") || strings.Contains(payload, "SHARED BODY") {
		t.Fatalf("read-only skills must be listed by name only: %s", payload)
	}
	if !strings.Contains(payload, "--- Skill: Deploy (writable,") || !strings.Contains(payload, "--- Memory: Bot MEMORY.md (read-only,") {
		t.Fatalf("payload = %s", payload)
	}
}

func TestSkillsPromptLeavesOutWritableSkillsThatDoNotFit(t *testing.T) {
	skills := []skillRecord{
		writableSkill("First", strings.Repeat("a", 60)),
		writableSkill("Second", strings.Repeat("b", 600)),
	}
	_, writable := skillsPrompt("Space", skills, []evidenceDocument{{Label: "m", Content: "# B\n\n- fact\n"}}, 100)
	if len(writable) != 1 || writable[0].Name != "First" {
		t.Fatalf("writable = %+v", writable)
	}
}

func TestHasFactsIgnoresAHeadingOnlyIndex(t *testing.T) {
	if hasFacts("# Bot\n\n") || !hasFacts("# Bot\n\n- tea\n") {
		t.Fatal("hasFacts is wrong")
	}
}

func TestCommandListNamesEveryCommand(t *testing.T) {
	list := CommandList()
	for _, name := range []string{CmdMemoryWrite, CmdMemoryArchive, CmdInstructionsSet, CmdSkillCreate, CmdSkillUpdate} {
		if !strings.Contains(list, name) {
			t.Errorf("command list is missing %s", name)
		}
	}
}
