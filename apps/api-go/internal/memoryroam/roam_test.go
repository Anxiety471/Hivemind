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

func TestValidateChangesAppliesWritableUpdates(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n\n- tea\n", 2),
		doc("2", UserMemoryPath, "- metric\n", 1),
		doc("3", "evidence-archive.md", "private evidence\n", 1),
	}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{
			{Path: memory.MemoryIndexPath, Content: "# Bot\n\n- tea\n- coffee\n"},
			{Path: UserMemoryPath, Content: "- metric\n- brief replies\n"},
		},
		Delete: []string{"evidence-archive.md"},
	}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 2 || validated.Updates[0].Path != memory.MemoryIndexPath ||
		validated.Updates[1].Path != UserMemoryPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 1 || validated.Ignored[0] != "evidence-archive.md" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesCreatesOnlyTheUserProfile(t *testing.T) {
	validated, err := validateChanges(answer{
		Documents: []answerDocument{
			{Path: UserMemoryPath, Content: "Name: Sam\n"},
			{Path: "new.md", Content: "a new fact\n"},
		},
	}, nil, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Current != nil ||
		validated.Updates[0].Path != UserMemoryPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 1 || validated.Ignored[0] != "new.md" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesRejectsUnsafeAnswers(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", "old.md", "x\n", 1),
	}
	cases := map[string]answer{
		"blank content": {Documents: []answerDocument{{Path: memory.MemoryIndexPath, Content: " "}}},
		"traversal":     {Documents: []answerDocument{{Path: "../x.md", Content: "x\n"}}},
		"non-markdown":  {Documents: []answerDocument{{Path: "notes.txt", Content: "x\n"}}},
	}
	for name, parsed := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := validateChanges(parsed, documents, nil, false, ""); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestValidateChangesKeepsTheExistingIndexHeading(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Original\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{{Path: memory.MemoryIndexPath, Content: "# Renamed\n\n- tea\n- coffee\n"}},
	}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Content != "# Original\n\n- tea\n- coffee\n" {
		t.Fatalf("updates = %+v", validated.Updates)
	}
}

func TestValidateChangesRestoresAMissingIndexHeading(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Original\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{{Path: memory.MemoryIndexPath, Content: "- tea\n- coffee\n"}},
	}, documents, nil, false, "")
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
	if _, err := validateChanges(answer{
		Documents: []answerDocument{{Path: UserMemoryPath, Content: "y\n"}},
	}, documents, []string{UserMemoryPath}, false, ""); err == nil {
		t.Fatal("expected an omitted-document error")
	}
}

func TestValidateChangesKeepsIdenticalContent(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{{Path: memory.MemoryIndexPath, Content: "# Bot\n\n- tea\n"}},
	}, documents, nil, false, "")
	if err != nil || len(validated.Updates) != 0 || len(validated.Ignored) != 0 {
		t.Fatalf("validated=%+v err=%v", validated, err)
	}
}

func TestValidateChangesEnforcesIndexCap(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n", 1)}
	tooBig := "# Bot\n\n" + strings.Repeat("x", BotMemoryMaxBytes)
	if _, err := validateChanges(answer{
		Documents: []answerDocument{{Path: memory.MemoryIndexPath, Content: tooBig}},
	}, documents, nil, false, ""); err == nil {
		t.Fatal("expected a size error")
	}
}

func TestValidateChangesNeverDeletesWritableDocuments(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", UserMemoryPath, "Name: Sam\n", 1),
	}
	validated, err := validateChanges(answer{
		Delete: []string{memory.MemoryIndexPath, UserMemoryPath},
	}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 0 {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 2 || validated.Ignored[0] != memory.MemoryIndexPath ||
		validated.Ignored[1] != UserMemoryPath {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesLeavesReadOnlyNotesAlone(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 1),
		doc("2", "evidence-archive.md", "private evidence\n", 1),
	}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{{Path: "evidence-archive.md", Content: "rewritten\n"}},
		Delete:    []string{"evidence-archive.md"},
	}, documents, nil, false, "")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 0 {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 2 {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesLimitsSharedMemoryToTheIndex(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Shared\n", 1),
		doc("2", UserMemoryPath, "bot profile\n", 1),
	}
	validated, err := validateChanges(answer{
		Documents: []answerDocument{
			{Path: UserMemoryPath, Content: "changed\n"},
			{Path: memory.MemoryIndexPath, Content: "# Shared\n\n- convention\n"},
		},
		Instructions: new("shared pass cannot change instructions\n"),
	}, documents, nil, true, "original instructions\n")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions != nil {
		t.Fatalf("shared pass changed instructions: %+v", validated.Instructions)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Path != memory.MemoryIndexPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Ignored) != 2 || validated.Ignored[0] != UserMemoryPath ||
		validated.Ignored[1] != "Instructions" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesUpdatesInstructions(t *testing.T) {
	validated, err := validateChanges(answer{
		Instructions: new("# Role\n\nNew rule.\n"),
	}, nil, nil, false, "# Role\n\nOld rule.\n")
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions == nil || *validated.Instructions != "# Role\n\nNew rule." {
		t.Fatalf("instructions = %v", validated.Instructions)
	}
}

func TestValidateChangesRejectsBlankInstructions(t *testing.T) {
	if _, err := validateChanges(answer{
		Instructions: new("  \n"),
	}, nil, nil, false, "# Role\n"); err == nil {
		t.Fatal("expected a blank-instructions error")
	}
}

func TestValidateChangesRejectsLongInstructions(t *testing.T) {
	if _, err := validateChanges(answer{
		Instructions: new(strings.Repeat("x", MaxInstructionsLength+1)),
	}, nil, nil, false, ""); err == nil {
		t.Fatal("expected an instructions-cap error")
	}
}

func TestValidateChangesKeepsIdenticalInstructions(t *testing.T) {
	validated, err := validateChanges(answer{
		Instructions: new("same instructions\n"),
	}, nil, nil, false, "same instructions\n")
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
	bot := systemPrompt(false)
	if !strings.Contains(bot, "Only four surfaces are in scope") ||
		!strings.Contains(bot, UserMemoryPath) ||
		!strings.Contains(bot, "Instructions are high authority") {
		t.Fatalf("bot prompt is not scoped: %s", bot)
	}
	shared := systemPrompt(true)
	if !strings.Contains(shared, "Only ONE document is writable") ||
		!strings.Contains(shared, memory.MemoryIndexPath) ||
		strings.Contains(shared, "Only four") {
		t.Fatalf("shared prompt is not scoped: %s", shared)
	}
}

func TestParseAnswerAcceptsFences(t *testing.T) {
	parsed, err := parseAnswer("```json\n{\"documents\":[{\"path\":\"MEMORY.md\",\"content\":\"# Bot\\n\"}]}\n```")
	if err != nil {
		t.Fatalf("parseAnswer: %v", err)
	}
	if len(parsed.Documents) != 1 || parsed.Documents[0].Path != memory.MemoryIndexPath {
		t.Fatalf("parsed = %+v", parsed)
	}
}

func TestInitialMemoryUsesOneHeadingLine(t *testing.T) {
	if got := initialMemory("A\nB"); got != "# A B\n\n" {
		t.Fatalf("initialMemory = %q", got)
	}
}
