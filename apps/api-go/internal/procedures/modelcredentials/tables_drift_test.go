package modelcredentials

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials/gentables"
)

// TestGeneratedModelTablesMatchSources is the drift gate: the committed tables must equal a fresh
// generation from the pinned dependency and the TypeScript presets. It skips when the sources are
// absent (a build without node_modules); the gate runs wherever the repo's dependencies are
// installed.
func TestGeneratedModelTablesMatchSources(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", ".."))
	pi := filepath.Join(root,
		"packages/adapters/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json")
	presets := filepath.Join(root,
		"packages/adapters/src/models/endpoints/openai-compatible-url.ts")
	committedPath := filepath.Join(root,
		"apps/api-go/internal/procedures/modelcredentials/tables_gen.go")
	for _, path := range []string{pi, presets} {
		if _, err := os.Stat(path); err != nil {
			t.Skipf("%s is absent; install the repository dependencies to run the drift gate", path)
		}
	}
	generated, err := gentables.Generate(pi, presets)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile(committedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(generated) != string(committed) {
		t.Fatal("model tables have drifted from their sources; run `cd apps/api-go && go run ./tools/gen-model-tables`")
	}
}
