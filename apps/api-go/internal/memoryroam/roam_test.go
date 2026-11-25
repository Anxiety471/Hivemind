package memoryroam

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/memory"
)

func doc(id, path, content string, revision int32) memory.Document {
	return memory.Document{ID: id, Path: path, Content: content, Revision: revision}
}

func write(path, content string) command {
	return command{Name: CmdMemoryWrite, Path: path, Content: content}
}

func archiveCmd(path, content string) command {
	return command{Name: CmdMemoryArchive, Path: path, Content: content}
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
		archiveCmd("archive/2026-11.md", "- [2026-11-25] wrapped up old audit"),
		{Name: "memory.delete", Path: "evidence-archive.md"},
	}}, documents, nil, false, "", false)
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Path != memory.MemoryIndexPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Archives) != 1 || validated.Archives[0].Path != "archive/2026-11.md" {
		t.Fatalf("archives = %+v", validated.Archives)
	}
	// Per-bot USER.md is no longer writable in passBot (consolidated into Space USER.md).
	if len(validated.Ignored) != 2 || validated.Ignored[0] != CmdMemoryWrite+" "+UserMemoryPath ||
		validated.Ignored[1] != "memory.delete" {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateChangesCreatesOnlySpaceUserProfileInSharedPass(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "Name: Sam\n"),
		write("new.md", "a new fact\n"),
	}}, nil, nil, true, "", false)
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
			if _, err := validateChanges(answer{Commands: []command{item}}, documents, nil, false, "", false); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestValidateChangesKeepsTheExistingIndexHeading(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Original\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Renamed\n\n- tea\n- coffee\n"),
	}}, documents, nil, false, "", false)
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
	}}, documents, nil, false, "", false)
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Content != "# Original\n\n- tea\n- coffee\n" {
		t.Fatalf("updates = %+v", validated.Updates)
	}
}

func TestValidateChangesAcceptsModelHeadingWhenExistingLackedOne(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "- legacy fact\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Bot\n\n- fact\n"),
	}}, documents, nil, false, "", false)
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 1 || validated.Updates[0].Content != "# Bot\n\n- fact\n" {
		t.Fatalf("updates = %+v", validated.Updates)
	}
}

func TestValidateChangesRefusesOmittedDocuments(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Shared\n", 1),
		doc("2", UserMemoryPath, "x\n", 1),
	}
	if _, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "y\n"),
	}}, documents, []string{UserMemoryPath}, true, "", false); err == nil {
		t.Fatal("expected an omitted-document error")
	}
}

func TestValidateChangesKeepsIdenticalContent(t *testing.T) {
	documents := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n\n- tea\n", 1)}
	validated, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Bot\n\n- tea\n"),
	}}, documents, nil, false, "", false)
	if err != nil || len(validated.Updates) != 0 || len(validated.Ignored) != 0 {
		t.Fatalf("validated=%+v err=%v", validated, err)
	}
}

func TestValidateChangesEnforcesTightCaps(t *testing.T) {
	botDocs := []memory.Document{doc("1", memory.MemoryIndexPath, "# Bot\n", 1)}
	tooBigBot := "# Bot\n\n" + strings.Repeat("x", BotMemoryMaxBytes)
	if _, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, tooBigBot),
	}}, botDocs, nil, false, "", false); err == nil {
		t.Fatal("expected a bot index size error")
	}

	sharedDocs := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Shared\n", 1),
		doc("2", UserMemoryPath, "Name: Sam\n", 1),
	}
	if _, err := validateChanges(answer{Commands: []command{
		write(memory.MemoryIndexPath, "# Shared\n\n"+strings.Repeat("x", SharedMemoryMaxBytes)),
	}}, sharedDocs, nil, true, "", false); err == nil {
		t.Fatal("expected a shared index size error")
	}
	if _, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, strings.Repeat("u", UserMemoryMaxBytes+1)),
	}}, sharedDocs, nil, true, "", false); err == nil {
		t.Fatal("expected a user profile size error")
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
	}}, documents, nil, false, "", false)
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
	}}, documents, nil, false, "", false)
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if len(validated.Updates) != 0 || len(validated.Ignored) != 1 {
		t.Fatalf("validated = %+v", validated)
	}
}

func TestValidateChangesAllowsMemoryWriteAndArchiveInSharedPass(t *testing.T) {
	documents := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Shared\n", 1),
		doc("2", UserMemoryPath, "Name: Sam\n", 1),
	}
	validated, err := validateChanges(answer{Commands: []command{
		write(UserMemoryPath, "Name: Sam\n- Concise replies\n"),
		write(memory.MemoryIndexPath, "# Shared\n\n- convention\n"),
		archiveCmd("archive/2026-11.md", "- [2026-11-25] archived milestone"),
		setInstructions("shared pass cannot change instructions\n"),
		{Name: CmdSkillCreate, Skill: "Nope", Description: "x", Body: "y"},
	}}, documents, nil, true, "original instructions\n", false)
	if err != nil {
		t.Fatalf("validateChanges: %v", err)
	}
	if validated.Instructions != nil {
		t.Fatalf("shared pass changed instructions: %+v", validated.Instructions)
	}
	if len(validated.Updates) != 2 || validated.Updates[0].Path != UserMemoryPath || validated.Updates[1].Path != memory.MemoryIndexPath {
		t.Fatalf("updates = %+v", validated.Updates)
	}
	if len(validated.Archives) != 1 || validated.Archives[0].Path != "archive/2026-11.md" {
		t.Fatalf("archives = %+v", validated.Archives)
	}
	if len(validated.Ignored) != 2 || validated.Ignored[0] != CmdInstructionsSet || validated.Ignored[1] != CmdSkillCreate {
		t.Fatalf("ignored = %v", validated.Ignored)
	}
}

func TestValidateMemoryArchiveAndAppend(t *testing.T) {
	bad := map[string]command{
		"non-archive":   archiveCmd("MEMORY.md", "- x"),
		"traversal":     archiveCmd("archive/../secret.md", "- x"),
		"non-markdown":  archiveCmd("archive/2026-11.txt", "- x"),
		"blank content": archiveCmd("archive/2026-11.md", "   "),
	}
	for name, item := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := validateChanges(answer{Commands: []command{item}}, nil, nil, false, "", false); err == nil {
				t.Fatalf("expected error for %s", name)
			}
		})
	}
	if _, err := validateChanges(answer{Commands: []command{
		archiveCmd("archive/2026-11.md", "- a"),
		archiveCmd("archive/2026-11.md", "- b"),
	}}, nil, nil, false, "", false); err == nil {
		t.Fatal("expected duplicate archive path error")
	}

	created, changed, err := appendArchive("", "archive/2026-11.md", "- [2026-11-25] one\n- [2026-11-25] two")
	if err != nil || !changed || created != "# Archive 2026-11\n\n- [2026-11-25] one\n- [2026-11-25] two\n" {
		t.Fatalf("created=%q changed=%v err=%v", created, changed, err)
	}
	deduped, changed, err := appendArchive(created, "archive/2026-11.md", "- [2026-11-25] two\n- [2026-11-25] three")
	if err != nil || !changed || deduped != "# Archive 2026-11\n\n- [2026-11-25] one\n- [2026-11-25] two\n- [2026-11-25] three\n" {
		t.Fatalf("deduped=%q changed=%v err=%v", deduped, changed, err)
	}
	noop, changed, err := appendArchive(deduped, "archive/2026-11.md", "- [2026-11-25] one")
	if err != nil || changed || noop != deduped {
		t.Fatalf("noop=%q changed=%v err=%v", noop, changed, err)
	}
}

func TestValidateChangesUpdatesInstructions(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions("# Role\n\nNew rule.\n"),
	}}, nil, nil, false, "# Role\n\nOld rule.\n", false)
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
	}}, nil, nil, false, "# Role\n", false); err == nil {
		t.Fatal("expected a blank-instructions error")
	}
}

func TestValidateChangesRejectsLongInstructions(t *testing.T) {
	if _, err := validateChanges(answer{Commands: []command{
		setInstructions(strings.Repeat("x", MaxInstructionsLength+1)),
	}}, nil, nil, false, "", false); err == nil {
		t.Fatal("expected an instructions-cap error")
	}
}

func TestValidateChangesRejectsExpandingOversizedInstructions(t *testing.T) {
	oversized := strings.Repeat("a", InstructionsSoftChars+50)
	if _, err := validateChanges(answer{Commands: []command{
		setInstructions(oversized + "more"),
	}}, nil, nil, false, oversized, true); err == nil {
		t.Fatal("expected error when expanding already-oversized instructions")
	}
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions("# Role\n\nCompact instructions."),
	}}, nil, nil, false, oversized, true)
	if err != nil || validated.Instructions == nil {
		t.Fatalf("expected shrinking oversized instructions to succeed, got %+v err=%v", validated, err)
	}
}

func TestValidateChangesGuardsAgainstLargeUnattendedShrink(t *testing.T) {
	existing := strings.Repeat("a", 1000)
	tooSmall := strings.Repeat("a", 500)
	if _, err := validateChanges(answer{Commands: []command{
		setInstructions(tooSmall),
	}}, nil, nil, false, existing, false); err == nil {
		t.Fatal("expected error when unattended run drops >40% of instructions")
	}
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions(tooSmall),
	}}, nil, nil, false, existing, true)
	if err != nil || validated.Instructions == nil {
		t.Fatalf("expected --compact run to allow >40%% shrink, got %+v err=%v", validated, err)
	}
}

func TestValidateChangesKeepsIdenticalInstructions(t *testing.T) {
	validated, err := validateChanges(answer{Commands: []command{
		setInstructions("same instructions\n"),
	}}, nil, nil, false, "same instructions\n", false)
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

func TestPromptForKeepsWritableDocumentsFirstAndSkipsArchives(t *testing.T) {
	docs := []memory.Document{
		doc("1", "evidence-archive.md", strings.Repeat("b", 200), 5),
		doc("2", UserMemoryPath, strings.Repeat("u", 40), 2),
		doc("3", memory.MemoryIndexPath, "# Shared\n\n"+strings.Repeat("a", 20), 3),
		doc("4", "archive/2026-11.md", "- archived note\n", 9),
	}
	payload, omitted := promptFor(Bot{Name: "Bot"}, docs, 140, true, botContext{Now: time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC)})
	if !strings.Contains(payload, "Writable surfaces: "+memory.MemoryIndexPath+", "+UserMemoryPath) {
		t.Fatalf("payload does not name the writable set: %s", payload)
	}
	if !strings.Contains(payload, "Today (UTC): 2026-11-25") {
		t.Fatalf("payload missing date: %s", payload)
	}
	if !strings.Contains(payload, memory.MemoryIndexPath) || !strings.Contains(payload, UserMemoryPath) {
		t.Fatalf("payload does not include both writable documents: %s", payload)
	}
	if strings.Contains(payload, "archive/2026-11.md") || strings.Contains(payload, "archived note") {
		t.Fatalf("archive docs must be omitted from hot prompt: %s", payload)
	}
	if len(omitted) != 1 || omitted[0] != "evidence-archive.md" {
		t.Fatalf("omitted = %v", omitted)
	}
	if strings.Index(payload, memory.MemoryIndexPath) > strings.Index(payload, UserMemoryPath) {
		t.Fatalf("index should come before USER.md: %s", payload)
	}
}

func TestPromptForIncludesWritableInstructionsAndGrounding(t *testing.T) {
	extra := botContext{
		Now:          time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC),
		SharedUser:   "- Name: Sam",
		SharedMemory: "# Shared\n\n- Space uses Postgres",
		OpenWork:     []openWorkItem{{Title: "Ship v2", Status: "open", UpdatedAt: time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)}},
		Skills:       []skillSummary{{Name: "Deploy", Description: "Deploy web"}},
	}
	docs := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n\n- note\n", 1),
		doc("2", UserMemoryPath, "- legacy user note\n", 1),
	}
	payload, _ := promptFor(Bot{Name: "Bot", Instructions: "# Role\n\nBe brief.\n"}, docs, 10_000, false, extra)
	if !strings.Contains(payload, "--- Instructions (writable; complete replacement if changed;") ||
		!strings.Contains(payload, "# Role\n\nBe brief.") {
		t.Fatalf("instructions are not in the prompt: %s", payload)
	}
	if !strings.Contains(payload, "Writable surfaces: "+memory.MemoryIndexPath+", Instructions") {
		t.Fatalf("writable surfaces unexpected: %s", payload)
	}
	if strings.Contains(payload, "legacy user note") {
		t.Fatalf("legacy per-bot USER.md should be skipped when Space USER.md exists: %s", payload)
	}
	for _, want := range []string{"Space USER.md (read-only", "Space MEMORY.md (read-only", "Open work (read-only", "Ship v2", "Available Skills (read-only", "- Deploy: Deploy web"} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %q in payload:\n%s", want, payload)
		}
	}
}

func TestPromptForMarksReadOnlyDocuments(t *testing.T) {
	docs := []memory.Document{
		doc("1", memory.MemoryIndexPath, "# Bot\n", 2),
		doc("2", UserMemoryPath, "- metric\n", 1),
		doc("3", "evidence-archive.md", "private evidence\n", 1),
	}
	payload, omitted := promptFor(Bot{Name: "Bot"}, docs, 10_000, false, botContext{})
	if len(omitted) != 0 {
		t.Fatalf("omitted = %v", omitted)
	}
	if !strings.Contains(payload, "evidence-archive.md (revision 1, 17 bytes, read-only)") {
		t.Fatalf("read-only document is not marked: %s", payload)
	}
	if !strings.Contains(payload, "USER.md (revision 1, 9 bytes, read-only)") {
		t.Fatalf("per-bot USER.md must be read-only in bot pass: %s", payload)
	}
}

func TestSystemPromptNamesTheScope(t *testing.T) {
	bot := systemPrompt(passBot, false, false)
	if !strings.Contains(bot, "Only three write operations are in scope") ||
		!strings.Contains(bot, CmdMemoryArchive) ||
		!strings.Contains(bot, "Instructions are high authority") {
		t.Fatalf("bot prompt is not scoped: %s", bot)
	}
	botCompact := systemPrompt(passBot, true, true)
	if !strings.Contains(botCompact, "INSTRUCTIONS COMPACTION ACTIVE") ||
		!strings.Contains(botCompact, "COMPACTION ACTIVE") {
		t.Fatalf("compact bot prompt missing compaction directives: %s", botCompact)
	}
	shared := systemPrompt(passShared, false, false)
	if !strings.Contains(shared, "Only shared memory is in scope") ||
		!strings.Contains(shared, memory.MemoryIndexPath) ||
		!strings.Contains(shared, UserMemoryPath) {
		t.Fatalf("shared prompt is not scoped: %s", shared)
	}
}

func TestEveryPassOffersOnlyTheCommandsItMayRun(t *testing.T) {
	cases := map[passKind]struct{ offered, withheld []string }{
		passBot:    {[]string{CmdMemoryWrite, CmdMemoryArchive, CmdInstructionsSet}, []string{CmdSkillCreate, CmdSkillUpdate}},
		passShared: {[]string{CmdMemoryWrite, CmdMemoryArchive}, []string{CmdInstructionsSet, CmdSkillCreate, CmdSkillUpdate}},
		passSkills: {[]string{CmdSkillCreate, CmdSkillUpdate}, []string{CmdMemoryWrite, CmdMemoryArchive, CmdInstructionsSet}},
	}
	for pass, want := range cases {
		prompt := systemPrompt(pass, false, false)
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

func TestHysteresisThresholdsAndSplitHeavyRewrites(t *testing.T) {
	mediumInstr := Bot{Name: "B", Instructions: strings.Repeat("a", 4200)}
	if shouldCompactInstructions(mediumInstr, nil, false) {
		t.Fatal("4200-char instructions must not trigger background compaction below 5000")
	}
	if !shouldCompactInstructions(mediumInstr, nil, true) {
		t.Fatal("4200-char instructions must trigger compaction under --compact")
	}
	largeInstr := Bot{Name: "B", Instructions: strings.Repeat("a", 5100)}
	if !shouldCompactInstructions(largeInstr, nil, false) {
		t.Fatal("5100-char instructions must trigger background compaction when memory is under trigger")
	}
	bigMem := []memory.Document{doc("1", memory.MemoryIndexPath, "# B\n\n"+strings.Repeat("m", BotMemoryTriggerBytes+10), 1)}
	if shouldCompactInstructions(largeInstr, bigMem, false) {
		t.Fatal("unattended pass must defer Instructions compaction when MEMORY.md is also over trigger")
	}
}

func TestStableInputHashIgnoresDateLine(t *testing.T) {
	p1 := "Memory owner: Bot\nToday (UTC): 2026-11-25\nMode: maintain\n\n# Bot\n- fact"
	p2 := "Memory owner: Bot\nToday (UTC): 2026-11-26\nMode: maintain\n\n# Bot\n- fact"
	p3 := "Memory owner: Bot\nToday (UTC): 2026-11-26\nMode: maintain\n\n# Bot\n- changed"
	if stableInputHash(p1) != stableInputHash(p2) {
		t.Fatalf("expected identical hash across dates: %s vs %s", stableInputHash(p1), stableInputHash(p2))
	}
	if stableInputHash(p2) == stableInputHash(p3) {
		t.Fatal("expected hash to change when content changes")
	}
}

func TestCompleteRetriesLengthTruncationAt32K(t *testing.T) {
	var maxTokensSeen []int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		var body openAIChatRequest
		_ = json.Unmarshal(raw, &body)
		maxTokensSeen = append(maxTokensSeen, body.MaxTokens)
		writer.Header().Set("content-type", "application/json")
		if len(maxTokensSeen) == 1 {
			_, _ = writer.Write([]byte(`{"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"completion_tokens":8192}}`))
			return
		}
		_, _ = writer.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"commands\":[]}"}}],"usage":{"completion_tokens":20}}`))
	}))
	defer server.Close()

	client, err := NewClient(ModelConfig{
		Style: "openai", BaseURL: server.URL, Model: "reasoning-model", APIKey: "k",
		MaxTokens: 8192, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	text, _, model, err := complete(context.Background(), nil, []*Client{client}, "sys", "prompt")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if model != "reasoning-model" || text != `{"commands":[]}` {
		t.Fatalf("unexpected response: model=%s text=%q", model, text)
	}
	if len(maxTokensSeen) != 2 || maxTokensSeen[0] != 8192 || maxTokensSeen[1] != 32_768 {
		t.Fatalf("maxTokensSeen = %v, want [8192 32768]", maxTokensSeen)
	}
}

func TestResolveArchiveTargetRollsOverWhenFull(t *testing.T) {
	fullContent := "# Archive 2026-11\n\n" + strings.Repeat("x", MaxOtherBytes-25)
	docs := []memory.Document{
		doc("1", "archive/2026-11.md", fullContent, 4),
	}
	path, merged, existing, changed, err := resolveArchiveTarget(docs, "archive/2026-11.md", "- [2026-11-25] rolled over entry")
	if err != nil {
		t.Fatalf("resolveArchiveTarget: %v", err)
	}
	if path != "archive/2026-11-2.md" || existing != nil || !changed {
		t.Fatalf("path=%s existing=%v changed=%v", path, existing, changed)
	}
	if !strings.Contains(merged, "# Archive 2026-11-2") || !strings.Contains(merged, "rolled over entry") {
		t.Fatalf("merged = %q", merged)
	}
}
