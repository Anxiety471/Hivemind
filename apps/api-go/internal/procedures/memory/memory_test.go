package memory

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

// The golden file holds buildAgentMemoryPrompt outputs from the real TypeScript
// implementation (packages/adapters/src/memory-context.prompt.ts) for the same inputs,
// generated with the deployed checkout's node_modules on 2026-11-19.
type goldenFile struct {
	Plans []struct {
		Name     string `json:"name"`
		MaxBytes int    `json:"maxBytes"`
		Docs     []struct {
			Scope     string `json:"scope"`
			Path      string `json:"path"`
			Revision  int32  `json:"revision"`
			UpdatedAt string `json:"updatedAt"`
			Content   string `json:"content"`
		} `json:"docs"`
		Plan PromptBudget `json:"plan"`
	} `json:"plans"`
	Truncation struct {
		Start []struct {
			Value    string `json:"value"`
			MaxBytes int    `json:"maxBytes"`
			Out      string `json:"out"`
		} `json:"start"`
		End []struct {
			Value    string `json:"value"`
			MaxBytes int    `json:"maxBytes"`
			Out      string `json:"out"`
		} `json:"end"`
	} `json:"truncation"`
	ByteLengths []struct {
		Value string `json:"value"`
		Bytes int    `json:"bytes"`
	} `json:"byteLengths"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/prompt-golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var golden goldenFile
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return golden
}

func TestBuildPlanMatchesTypeScript(t *testing.T) {
	golden := loadGolden(t)
	if len(golden.Plans) == 0 {
		t.Fatal("golden has no plans")
	}
	for _, testCase := range golden.Plans {
		t.Run(testCase.Name, func(t *testing.T) {
			documents := make([]promptDocument, 0, len(testCase.Docs))
			for _, doc := range testCase.Docs {
				documents = append(documents, promptDocument{
					Scope: doc.Scope, Path: doc.Path, Revision: doc.Revision,
					UpdatedAt: doc.UpdatedAt, Content: doc.Content,
				})
			}
			got := buildPlan(documents, testCase.MaxBytes)
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(testCase.Plan)
			if string(gotJSON) != string(wantJSON) {
				t.Fatalf("plan differs\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestTruncateUTF8MatchesTypeScript(t *testing.T) {
	golden := loadGolden(t)
	for _, entry := range golden.ByteLengths {
		if got := byteLength(entry.Value); got != entry.Bytes {
			t.Errorf("byteLength(%q) = %d, want %d", entry.Value, got, entry.Bytes)
		}
	}
	for _, entry := range golden.Truncation.Start {
		if got := truncateUtf8(entry.Value, entry.MaxBytes, false); got != entry.Out {
			t.Errorf("truncateUtf8(%q, %d, start) = %q, want %q", entry.Value, entry.MaxBytes, got, entry.Out)
		}
	}
	for _, entry := range golden.Truncation.End {
		if got := truncateUtf8(entry.Value, entry.MaxBytes, true); got != entry.Out {
			t.Errorf("truncateUtf8(%q, %d, end) = %q, want %q", entry.Value, entry.MaxBytes, got, entry.Out)
		}
	}
}

func TestWrittenIsTheStoredPlaintext(t *testing.T) {
	// Sealing runs before withTextSanitization, so a sealed value is stored exactly as sent: a NUL
	// inside the ciphertext is what TypeScript stores too (and what the harness compares).
	encrypting := &contentcrypto.KeyRing{EncryptWrites: true}
	if got := written(encrypting, "a\x00b"); got != "a\x00b" {
		t.Errorf("encrypted write must be stored as sent, got %q", got)
	}
	if got := written(encrypting, "rkz1:k1:AAAA"); got != "rkz1:k1:AAAA" {
		t.Errorf("encrypting write that looks like ciphertext = %q", got)
	}
	// A plaintext write is sanitized afterwards, and ciphertext-looking text stays reachable.
	ring := &contentcrypto.KeyRing{EncryptWrites: false}
	if got := written(ring, "a\x00b"); got != "a\uFFFDb" {
		t.Errorf("plaintext write NUL = %q", got)
	}
	if got := written(ring, "rkz1:k1:AAAA"); got != "\u200brkz1:k1:AAAA" {
		t.Errorf("plaintext write that looks like ciphertext = %q", got)
	}
	if got := written(ring, "rkz1:"); got != "rkz1:" {
		t.Errorf("rkz1: without a key id must stay as is, got %q", got)
	}
}
