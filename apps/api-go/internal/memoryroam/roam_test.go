package memoryroam

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/memory"
)

func doc(id, path, content string, revision int32) memory.Document {
	return memory.Document{ID: id, Path: path, Content: content, Revision: revision}
}

func write(path, content string) command {
	return command{Name: CmdMemoryWrite, Path: path, Content: content}
}

func setInstructions(content string) command {
	return command{Name: CmdInstructionsSet, Content: content}
}

func TestValidateChangesAppliesWritableUpdates(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n\n- tea\n", 2),
		doc("2", UserMemoryPath, "- metric\n", 1),
		doc("3", "evidence-archive.md", "private evidence\n", 1),
	}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Bot\n\n- tea\n- coffee\n"),
		write(UserMemoryPath, "- metric\n- brief replies\n"),
		{Name: "memory.delete", Path: "evidence-archive.md"},
	}}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 2 || validated.Updates[0].Path != memory.MemoryIndexPath ||
		validated.Updates[1].Path != UserMemoryPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 1 || validated.Ignored[0] != "memory.delete" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesCreatesOnlyTheUserProfile(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "Name: Sam\n"),
		write("new.md", "a new fact\n"),
	}}, nil, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Current != nil ||
		validated.Updates[0].Path != UserMemoryPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 1 || validated.Ignored[0] != CmdMemoryWrite+" new.md" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesRejectsUnsafeAnswers(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", "old.md", "x\n", 1),
	}
	cases := map[string]command{
		"blank content": write(memory.MemoryIndexPath, " "),
		"traversal":     write("../x.md", "x\n"),
		"non-markdown":  write("notes.txt", "x\n"),
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := validateChanges(answer{Commands: []command{item}}, documents, nil, false, ""); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestValidateChangesKeepsTheExistingIndexHeading(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Original\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Renamed\n\n- tea\n- coffee\n"),
	}}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Content != "# Original\n\n- tea\n- coffee\n" {
		t.Fatalf("updates = %+v", validated.Updates)
	}
}

func TestValidateChangesRestoresAMissingIndexHeading(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Original\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "- tea\n- coffee\n"),
	}}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Content != "# Original\n\n- tea\n- coffee\n" {
		t.Fatalf("updates = %+v", validated.Updates)
	}
}

func TestValidateChangesRefusesOmittedDocuments(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", UserMemoryPath, "x\n", 1),
	}
	if _, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "y\n"),
	}}, documents, []string{UserMemoryPath}, false, ""); err == nil {
		t.Fatal("expected an omitted-document error")
	}
}

func TestValidateChangesKeepsIdenticalContent(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Bot\n\n- tea\n"),
	}}, documents, nil, false, "")
	if err != nil || len(validated.Updates) != 0 || len(validated.Ignored) != 0 {
		t.Fatalf("validated=%+v err=%v", validated, err)
	}
}

func TestValidateChangesEnforcesIndexCap(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n", 1)}
	tooBig := "# Bot\n\n" + strings.Repeat("x", BotMemoryMaxBytes)
	if _, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, tooBig),
	}}, documents, nil, false, ""); err == nil {
		t.Fatal("expected a size error")
	}
}

func TestValidateChangesHasNoDeleteOrShellCommand(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", UserMemoryPath, "Name: Sam\n", 1),
	}
	validated, err := validateChanges(answer{Commands: []command{
		{Name: "memory.delete", Path: memory.MemoryIndexPath},
		{Name: "shell", Content: "rm -rf /"},
	}}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 0 || validated.Instructions != nil {
		t.Fatalf("validated = %+v", validated)
	}
	if len(validated.Ignored) != 2 || validated.Ignored[0] != "memory.delete" || validated.Ignored[1] != "shell" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesLeavesReadOnlyNotesAlone(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", "evidence-archive.md", "private evidence\n", 1),
	}
	validated, err := validateChanges(answer{Commands: []command{
		write("evidence-archive.md", "rewritten\n"),
	}}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 0 || len(validated.Ignored) != 1 {
		t.Fatalf("validated = %+v", validated)
	}
}

func TestValidateChangesLimitsSharedMemoryToTheIndex(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Shared\n", 1),
		doc("2", UserMemoryPath, "bot profile\n", 1),
	}
	validated, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "changed\n"),
		write(memory.MemoryIndexPath, "# Shared\n\n- convention\n"),
		setInstructions("shared pass cannot change instructions\n"),
		{Name: CmdSkillCreate, Skill: "Nope", Description: "x", Body: "y"},
	}}, documents, nil, true, "original instructions\n")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions != nil {
		t.Fatalf("shared pass changed instructions: %+v", validated.Instructions)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Path != memory.MemoryIndexPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 3 || validated.Ignored[0] != CmdMemoryWrite+" "+UserMemoryPath ||
		validated.Ignored[1] != CmdInstructionsSet || validated.Ignored[2] != CmdSkillCreate {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesUpdatesInstructions(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions("# Role\n\nNew rule.\n"),
	}}, nil, nil, false, "# Role\n\nOld rule.\n")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions == nil || *validated.Instructions != "# Role\n\nNew rule." {
		t.Fatalf("instructions = %v", validated.Instructions)
	}
}

func TestValidateChangesRejectsBlankInstructions(t *testing.T) {
	if _, err := validateChanges(answer{Commands: []command{
		setInstructions("  \n"),
	}}, nil, nil, false, "# Role\n"); err == nil {
		t.Fatal("expected a blank-instructions error")
	}
}

func TestValidateChangesRejectsLongInstructions(t *testing.T) {
	if _, err := validateChanges(answer{Commands: []command{
		setInstructions(strings.Repeat("x", MaxInstructionsLength+1)),
	}}, nil, nil, false, ""); err == nil {
		t.Fatal("expected an instructions-cap error")
	}
}

func TestValidateChangesKeepsIdenticalInstructions(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions("same instructions\n"),
	}}, nil, nil, false, "same instructions\n")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions != nil {
		t.Fatalf("instructions = %v", validated.Instructions)
	}
}

func TestPrependInstructionVersionKeepsThePreviousText(t *testing.T) {
	raw := []byte(`[{"id":"old","instructions":"older","reason":"Manual edit","createdAt":"2026-01-01T00:00:00.000Z"}]`)
	out, err := prependInstructionVersion(raw, "current")
	if err != nil {
		t.Fatalf("prependInstructionVersion: %v", err)
	}
	var history []instructionVersion
	if err := json.Unmarshal(out, &history); err != nil {
		t.Fatalf("history is not valid JSON: %v", err)
	}
	if len(history) != 2 || history[0].Instructions != "current" || history[0].Reason != "Memory roamer" ||
		history[0].ID == "" || history[1].Instructions != "older" {
		t.Fatalf("history = %+v", history)
	}
}

func TestPrependInstructionVersionCapsHistoryAtTwenty(t *testing.T) {
	history := make([]instructionVersion, 25)
	for index := range history {
		history[index] = instructionVersion{ID: "old", Instructions: "old", Reason: "Manual edit"}
	}
	raw, _ := json.Marshal(history)
	out, err := prependInstructionVersion(raw, "current")
	if err != nil {
		t.Fatalf("prependInstructionVersion: %v", err)
	}
	var capped []instructionVersion
	if err := json.Unmarshal(out, &capped); err != nil {
		t.Fatalf("history is not valid JSON: %v", err)
	}
	if len(capped) != 20 || capped[0].Instructions != "current" {
		t.Fatalf("history length = %d", len(capped))
	}
}

func TestPrependInstructionVersionRejectsMalformedHistory(t *testing.T) {
	if _, err := prependInstructionVersion([]byte(`{"not":"an array"}`), "current"); err == nil {
		t.Fatal("expected a malformed-history error")
	}
}

func TestPromptForKeepsWritableDocumentsFirst(t *testing.T) {
	docs := []memory.Document{
		doc("1", "evidence-archive.md", strings.Repeat("b", 200), 5),
		doc("2", UserMemoryPath, strings.Repeat("u", 40), 2),
		doc("3", memory.MemoryIndexPath, "# Bot\n\n"+strings.Repeat("a", 20), 3),
	}
	payload, omitted := promptFor(Bot{Name: "Bot"}, docs, 120, false)
	if !strings.Contains(payload, "Writable surfaces: "+memory.MemoryIndexPath+", "+UserMemoryPath) {
		t.Fatalf("payload does not name the writable set: %s", payload)
	}
	if !strings.Contains(payload, memory.MemoryIndexPath) || !strings.Contains(payload, UserMemoryPath) {
		t.Fatalf("payload does not include both writable documents: %s", payload)
	}
	if len(omitted) != 1 || omitted[0] != "evidence-archive.md" {
		t.Fatalf("omitted = %v", omitted)
	}
	if strings.Index(payload, memory.MemoryIndexPath) > strings.Index(payload, UserMemoryPath) {
		t.Fatalf("index should come before USER.md: %s", payload)
	}
}

func TestPromptForIncludesWritableInstructions(t *testing.T) {
	payload, _ := promptFor(Bot{Name: "Bot", Instructions: "# Role\n\nBe brief.\n"}, nil, 10_000, false)
	if !strings.Contains(payload, "--- Instructions (writable; complete replacement if changed;") ||
		!strings.Contains(payload, "# Role\n\nBe brief.") {
		t.Fatalf("instructions are not in the prompt: %s", payload)
	}
	if !strings.Contains(payload, "Writable surfaces: "+memory.MemoryIndexPath+", "+UserMemoryPath+", Instructions") {
		t.Fatalf("instructions are not named as writable: %s", payload)
	}
}

func TestPromptForMarksReadOnlyDocuments(t *testing.T) {
	docs := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 2),
		doc("2", UserMemoryPath, "- metric\n", 1),
		doc("3", "evidence-archive.md", "private evidence\n", 1),
	}
	payload, omitted := promptFor(Bot{Name: "Bot"}, docs, 10_000, false)
	if len(omitted) != 0 {
		t.Fatalf("omitted = %v", omitted)
	}
	if !strings.Contains(payload, "evidence-archive.md (revision 1, 17 bytes, read-only)") {
		t.Fatalf("read-only document is not marked: %s", payload)
	}
	if strings.Contains(payload, "USER.md (revision 1, 9 bytes, read-only)") {
		t.Fatalf("USER.md must be writable: %s", payload)
	}
}

func TestSystemPromptNamesTheScope(t *testing.T) {
	bot := systemPrompt(passBot)
	if !strings.Contains(bot, "Only four surfaces are in scope") ||
		!strings.Contains(bot, UserMemoryPath) ||
		!strings.Contains(bot, "Instructions are high authority") {
		t.Fatalf("bot prompt is not scoped: %s", bot)
	}
	shared := systemPrompt(passShared)
	if !strings.Contains(shared, "Only ONE document is writable") ||
		!strings.Contains(shared, memory.MemoryIndexPath) ||
		strings.Contains(shared, "Only four") {
		t.Fatalf("shared prompt is not scoped: %s", shared)
	}
}

func TestEveryPassOffersOnlyTheCommandsItMayRun(t *testing.T) {
	cases := map[passKind]struct{ offered, withheld []string }{
		passBot:    {[]string{CmdMemoryWrite, CmdInstructionsSet}, []string{CmdSkillCreate, CmdSkillUpdate}},
		passShared: {[]string{CmdMemoryWrite}, []string{CmdInstructionsSet, CmdSkillCreate, CmdSkillUpdate}},
		passSkills: {[]string{CmdSkillCreate, CmdSkillUpdate}, []string{CmdMemoryWrite, CmdInstructionsSet}},
	}
	for pass, want := range cases {
		prompt := systemPrompt(pass)
		for _, name := range want.offered {
			if !strings.Contains(prompt, `{"name":"`+name+`"`) {
				t.Errorf("pass %d does not offer %s", pass, name)
			}
		}
		for _, name := range want.withheld {
			if strings.Contains(prompt, `{"name":"`+name+`"`) {
				t.Errorf("pass %d offers %s", pass, name)
			}
		}
	}
}

func TestParseAnswerAcceptsFences(t *testing.T) {
	parsed, err := parseAnswer("```json\n{\"commands\":[{\"name\":\"memory.write\",\"path\":\"MEMORY.md\",\"content\":\"# Bot\\n\"}]}\n```")
	if err != nil {
		t.Fatalf("parseAnswer: %v", err)
	}
	if len(parsed.Commands) != 1 || parsed.Commands[0].Name != CmdMemoryWrite ||
		parsed.Commands[0].Path != memory.MemoryIndexPath {
		t.Fatalf("parsed = %+v", parsed)
	}
}

func TestInitialMemoryUsesOneHeadingLine(t *testing.T) {
	if got := initialMemory("A\nB"); got != "# A B\n\n" {
		t.Fatalf("initialMemory = %q", got)
	}
}
