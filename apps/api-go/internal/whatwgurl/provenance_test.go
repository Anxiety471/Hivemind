package whatwgurl

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestNodeVersionProvenance guards the committed UTS #46 tables against a
// silent regeneration under a different ICU or Unicode release. The probe
// outputs, the pinned constants and the parser behavior must all describe the
// same runtime.
func TestNodeVersionProvenance(t *testing.T) {
	node := provenanceNode(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, node, "-p", "JSON.stringify(process.versions)").Output()
	if err != nil {
		t.Fatalf("run %s to inspect process.versions: %v", node, err)
	}
	var got struct {
		Node    string `json:"node"`
		ICU     string `json:"icu"`
		Unicode string `json:"unicode"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("parse process.versions from %s: %v", node, err)
	}
	if got.ICU != ICUVersion || got.Unicode != UnicodeVersion {
		t.Fatalf("node at %s reports ICU %s and Unicode %s; the committed UTS #46 tables are pinned to Node %s, ICU %s and Unicode %s. Regenerate the probe outputs and tables with the pinned runtime (apps/api-go/tools/idna-mapping-cases.mts, idna-bidi-cases.mts, idna-context-cases.mts, then `go generate ./internal/whatwgurl`).", node, got.ICU, got.Unicode, NodeVersion, ICUVersion, UnicodeVersion)
	}
}

// provenanceNode resolves the node used by the provenance check. An explicit
// RAKAZO_NODE wins; otherwise the conventional user-local Node 24 path and
// PATH are tried. Only a genuinely absent node may skip.
func provenanceNode(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("RAKAZO_NODE"); path != "" {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("RAKAZO_NODE=%q is not available: %v", path, err)
		}
		return path
	}
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".local", "opt", "node24", "bin", "node")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	if path, err := exec.LookPath("node"); err == nil {
		return path
	}
	t.Skip("no node available (set RAKAZO_NODE, install ~/.local/opt/node24/bin/node, or put node on PATH); cannot verify the pinned ICU/Unicode versions")
	return ""
}
