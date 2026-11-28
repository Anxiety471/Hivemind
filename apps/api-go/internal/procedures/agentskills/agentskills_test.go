package agentskills

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func issuesOf(t *testing.T, failure *orpc.Error) []map[string]any {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a validation failure")
	}
	data, ok := failure.Data.(map[string]any)
	if !ok {
		t.Fatalf("failure data = %#v", failure.Data)
	}
	issues, _ := data["issues"].([]map[string]any)
	return issues
}

func TestParseGetIssues(t *testing.T) {
	_, failure := ParseGet(input(`{}`))
	issues := issuesOf(t, failure)
	if len(issues) != 1 || issues[0]["code"] != "custom" || issues[0]["message"] != "Provide skillId or name" {
		t.Fatalf("empty issues = %#v", issues)
	}
	if path, _ := json.Marshal(issues[0]["path"]); string(path) != `["skillId"]` {
		t.Fatalf("path = %s", path)
	}
	_, failure = ParseGet(input(`{"name":"   "}`))
	if issues := issuesOf(t, failure); len(issues) != 1 || issues[0]["code"] != "custom" {
		t.Fatalf("blank name issues = %#v", issues)
	}
	_, failure = ParseGet(input(`{"name":""}`))
	if issues := issuesOf(t, failure); len(issues) != 2 || issues[0]["code"] != "too_small" || issues[1]["code"] != "custom" {
		t.Fatalf("empty name issues = %#v", issues)
	}
	_, failure = ParseGet(input(`{"skillId":""}`))
	if issues := issuesOf(t, failure); len(issues) != 2 || issues[1]["code"] != "custom" {
		t.Fatalf("empty id issues = %#v", issues)
	}
	_, failure = ParseGet(input(`{"name":5}`))
	if issues := issuesOf(t, failure); len(issues) != 1 || issues[0]["code"] != "invalid_type" {
		t.Fatalf("number name issues = %#v", issues)
	}
	if got, failure := ParseGet(input(`{"skillId":"x"}`)); failure != nil || got.SkillID != "x" {
		t.Fatalf("skillId = %q, failure = %v", got.SkillID, failure)
	}
	if got, failure := ParseGet(input(`{"skillId":"x","name":"Rakazo","extra":1}`)); failure != nil || got.SkillID != "x" || got.Name != "Rakazo" {
		t.Fatalf("both = %+v, failure = %v", got, failure)
	}
	_, failure = ParseGet(input(`{"name":"` + strings.Repeat("a", 81) + `"}`))
	if issues := issuesOf(t, failure); len(issues) != 1 || issues[0]["code"] != "too_big" {
		t.Fatalf("long name issues = %#v", issues)
	}
}

func TestBuiltinCatalogAndLookup(t *testing.T) {
	catalog := builtinCatalog()
	if len(catalog) != 8 || catalog[0].ID != "builtin:Interrogate" || catalog[1].ID != "builtin:Rakazo" || catalog[2].ID != "builtin:Tasks" || catalog[3].ID != "builtin:History" || catalog[4].ID != "builtin:Routines" || catalog[5].ID != "builtin:Computer" || catalog[6].ID != "builtin:Subagents" || catalog[7].ID != "builtin:Documents" {
		t.Fatalf("catalog = %#v", catalog)
	}
	if catalog[0].Content == "" || catalog[0].CreatedAt != epoch {
		t.Fatalf("builtin = %#v", catalog[0])
	}
	if found := findSkillByName(catalog, "  rakazo "); found == nil || found.Name != "Rakazo" {
		t.Fatalf("lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "tasks"); found == nil || found.Name != "Tasks" {
		t.Fatalf("tasks lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "history"); found == nil || found.Name != "History" {
		t.Fatalf("history lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "computer"); found == nil || found.Name != "Computer" {
		t.Fatalf("computer lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "subagents"); found == nil || found.Name != "Subagents" {
		t.Fatalf("subagents lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "documents"); found == nil || found.Name != "Documents" {
		t.Fatalf("documents lookup = %#v", found)
	}
	if found := findSkillByName(catalog, "   "); found != nil {
		t.Fatalf("blank lookup = %#v", found)
	}
	users := []Skill{{ID: "u1", Name: "rakazo"}}
	merged := mergeBuiltinSkills(catalog, users)
	if len(merged) != 8 || merged[0].ID != "builtin:Interrogate" || merged[1].ID != "builtin:Tasks" || merged[2].ID != "builtin:History" || merged[3].ID != "builtin:Routines" || merged[4].ID != "builtin:Computer" || merged[5].ID != "builtin:Subagents" || merged[6].ID != "builtin:Documents" || merged[7].ID != "u1" {
		t.Fatalf("merged = %#v", merged)
	}
}

func TestSpaceAvailabilityKeepsTheHomeSpaceFirst(t *testing.T) {
	availability := spaceAvailability("s1", false, []string{"s1", "s2", "s3"})
	if !equalStrings(availability.SpaceIDs, []string{"s1", "s2", "s3"}) {
		t.Fatalf("spaceIds = %v", availability.SpaceIDs)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
