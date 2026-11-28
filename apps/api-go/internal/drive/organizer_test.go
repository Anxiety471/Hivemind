package drive

import (
	"encoding/json"
	"strings"
	"testing"
)

func strPtr(v string) *string { return &v }

func TestParseOrganizerPlanStripsFencesAndExtractsJSON(t *testing.T) {
	raw := "Sure, here is the metadata:\n```json\n{\n  \"folderId\": null,\n  \"newFolderName\": \"Invoices\",\n  \"name\": \"acme-invoice-jan-2026.pdf\",\n  \"description\": \"January 2026 invoice from Acme Corp.\",\n  \"slug\": \"acme-invoice-jan-2026\"\n}\n```"
	plan, err := parseOrganizerPlan(raw)
	if err != nil {
		t.Fatalf("parseOrganizerPlan failed: %v", err)
	}
	if plan.NewFolderName == nil || *plan.NewFolderName != "Invoices" {
		t.Fatalf("NewFolderName = %v, want Invoices", plan.NewFolderName)
	}
	if plan.Name == nil || *plan.Name != "acme-invoice-jan-2026.pdf" {
		t.Fatalf("Name = %v, want acme-invoice-jan-2026.pdf", plan.Name)
	}
	if plan.Slug == nil || *plan.Slug != "acme-invoice-jan-2026" {
		t.Fatalf("Slug = %v, want acme-invoice-jan-2026", plan.Slug)
	}
	if plan.Description == nil || *plan.Description == "" {
		t.Fatalf("expected non-empty Description, got %v", plan.Description)
	}

	if _, err := parseOrganizerPlan("not json at all"); err == nil {
		t.Fatal("expected parseOrganizerPlan to fail on invalid JSON")
	}
}

func TestPreservesExtension(t *testing.T) {
	if !preservesExtension("IMG_0012.PNG", "product-hero.png") {
		t.Fatal("expected case-insensitive matching extension to be allowed")
	}
	if preservesExtension("report.pdf", "report.html") {
		t.Fatal("expected changed extension to be rejected")
	}
	if !preservesExtension("README", "project-overview") {
		t.Fatal("expected extensionless original file to allow clean rename")
	}
}

func TestBuildOrganizerPromptIncludesUntrustedPreviewAndContext(t *testing.T) {
	artifact := organizerArtifact{
		ID:       "file-1",
		Name:     "IMG_1234.txt",
		Slug:     strPtr("img-1234"),
		MimeType: "text/plain",
		Size:     42,
	}
	folders := []organizerFolder{{ID: "folder-1", Name: "Research"}}
	bots := []organizerBot{{ID: "bot-1", Name: "Analyst", Description: "Financial reports"}}

	prompt := buildOrganizerPrompt(artifact, folders, bots, false, "Q4 budget summary")
	var decoded map[string]any
	if err := json.Unmarshal([]byte(prompt), &decoded); err != nil {
		t.Fatalf("buildOrganizerPrompt output invalid JSON: %v", err)
	}
	if decoded["untrustedPreview"] != "Q4 budget summary" {
		t.Fatalf("untrustedPreview = %v", decoded["untrustedPreview"])
	}
	if !strings.Contains(prompt, `"hadExplicitFolder":false`) {
		t.Fatalf("expected hadExplicitFolder=false in prompt: %s", prompt)
	}
}
