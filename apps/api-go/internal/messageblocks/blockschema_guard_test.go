package messageblocks

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// The fixture is generated from TypeScript's zod by tools/blockschema-fixture.mts: for every
// MessageBlock variant it holds one block with EVERY declared field filled and junk keys added at
// every level, the body zod keeps (junk stripped), one mutated block per declared
// maxLength/minLength/maxItems/minimum/exclusiveMinimum cap, one block per removed optional key
// (which is what exercises a `.default()` and a refinement that only fires on an absent key),
// blocks only a refinement refuses, and boundary-valid controls. Driving the real parsers with it
// makes TS the oracle for the whole field list, not a hand-kept subset: a field TS adds is present
// in `block` and must survive in `expected`, a cap TS changes is mutated at the new boundary, and a
// field Go drops shows up as a stripped key. `TestBlockSchemaFixtureIsCurrent` proves the fixture
// still matches the schemas.
type schemaFixture struct {
	Source   string          `json:"source"`
	Variants []schemaVariant `json:"variants"`
}

type schemaVariant struct {
	Kind      string           `json:"kind"`
	Block     json.RawMessage  `json:"block"`
	Expected  json.RawMessage  `json:"expected"`
	Probes    []schemaProbe    `json:"probes"`
	Omissions []schemaOmission `json:"omissions"`
	Refusals  []schemaRefusal  `json:"refusals"`
	Accepts   []schemaAccept   `json:"accepts"`
}

type schemaProbe struct {
	Path  []any           `json:"path"`
	Why   string          `json:"why"`
	Block json.RawMessage `json:"block"`
}

type schemaOmission struct {
	Path     []any           `json:"path"`
	Why      string          `json:"why"`
	Block    json.RawMessage `json:"block"`
	Expected json.RawMessage `json:"expected"`
}

type schemaRefusal struct {
	Why   string          `json:"why"`
	Block json.RawMessage `json:"block"`
}

type schemaAccept struct {
	Why      string          `json:"why"`
	Block    json.RawMessage `json:"block"`
	Expected json.RawMessage `json:"expected"`
}

func readSchemaFixture(t *testing.T) schemaFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/message-blocks-schema.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture schemaFixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if len(fixture.Variants) == 0 {
		t.Fatal("fixture has no variants")
	}
	return fixture
}

// decodeJSON reads a fixture value the way the router reads a stored jsonb block: through
// DecodeJSON, which keeps every number a json.Number. Decoding with a plain json.Unmarshal would
// hand the parsers float64, a form no jsonb read produces, and every z.number().int() check would
// fail for a reason production never sees.
func decodeJSON(t *testing.T, raw []byte) any {
	t.Helper()
	value, err := DecodeJSON(raw)
	if err != nil {
		t.Fatalf("decode block: %v", err)
	}
	return value
}

// parseOne is the production path for one block: ParseBlocks is MessageBlock.array().parse, the
// call threads.get, threads.messages and the live reads make on a stored list.
func parseOne(t *testing.T, raw []byte) (any, bool) {
	t.Helper()
	blocks, valid := ParseBlocks([]any{decodeJSON(t, raw)})
	if !valid {
		return nil, false
	}
	return blocks[0], true
}

// assertParsed requires Go to accept a block zod accepts and to return exactly zod's body.
func assertParsed(t *testing.T, why string, block, expected json.RawMessage) {
	t.Helper()
	cleaned, ok := parseOne(t, block)
	if !ok {
		t.Fatalf("%s: a block TypeScript accepts was refused; block=%s", why, block)
	}
	got := decodeJSON(t, mustMarshal(t, cleaned))
	want := decodeJSON(t, expected)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: cleaned block differs from zod's output (a field Go drops, or a value it rewrites)\n got: %v\nwant: %v", why, got, want)
	}
}

// TestBlockSchemasMatchTypeScriptFieldsAndCaps is the field-list, cap, default and refinement
// guard. Every variant of MessageBlock must accept the all-fields block, every optional-key
// omission and every accepted control, return exactly the body zod returns (junk keys stripped at
// every level, defaults filled), and refuse every cap mutation and refinement case TypeScript
// refuses.
func TestBlockSchemasMatchTypeScriptFieldsAndCaps(t *testing.T) {
	fixture := readSchemaFixture(t)
	for _, variant := range fixture.Variants {
		variant := variant
		t.Run(variant.Kind, func(t *testing.T) {
			if _, ok := blockSchemas[variant.Kind]; !ok {
				t.Fatalf("blockSchemas has no %q parser", variant.Kind)
			}
			assertParsed(t, "all-fields block", variant.Block, variant.Expected)
			for _, omit := range variant.Omissions {
				assertParsed(t, omit.Why, omit.Block, omit.Expected)
			}
			for _, accept := range variant.Accepts {
				assertParsed(t, accept.Why, accept.Block, accept.Expected)
			}
			for _, probe := range variant.Probes {
				if _, ok := parseOne(t, probe.Block); ok {
					t.Errorf("cap probe %q at %v was accepted; TypeScript refuses it", probe.Why, probe.Path)
				}
			}
			for _, refusal := range variant.Refusals {
				if _, ok := parseOne(t, refusal.Block); ok {
					t.Errorf("%s: accepted; TypeScript refuses it", refusal.Why)
				}
			}
		})
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

// TestBlockSchemaFixtureIsCurrent regenerates the fixture from the TypeScript schemas and requires
// it to be byte-identical, so a field, cap or refinement added in TS cannot pass without the Go
// side being driven at the new shape. The workflow (`.github/workflows/api-go.yml`) installs the
// workspace through `./.github/actions/setup-workspace`, so CI has tsx and fails here when it does
// not; a local Go-only run without an install skips instead.
func TestBlockSchemaFixtureIsCurrent(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	tsx := filepath.Join(root, "node_modules", ".bin", "tsx")
	if _, err := os.Stat(tsx); err != nil {
		if os.Getenv("CI") == "true" {
			t.Fatalf("tsx is missing at %s under CI: the workflow must install the workspace so the TypeScript oracle runs (%v)", tsx, err)
		}
		t.Skip("tsx is not installed; run pnpm install to check the TypeScript oracle")
	}
	cmd := exec.Command(tsx, "apps/api-go/tools/blockschema-fixture.mts")
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		// CombinedOutput keeps the generator's own message (a missing zod, a sample TS refuses)
		// beside the exit status; Output() would report only "exit status 1".
		t.Fatalf("regenerate fixture: %v\n%s", err, out)
	}
	want, err := os.ReadFile("testdata/message-blocks-schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, want) {
		t.Fatal("testdata/message-blocks-schema.json is stale: regenerate it with\n" +
			"  node_modules/.bin/tsx apps/api-go/tools/blockschema-fixture.mts > apps/api-go/internal/messageblocks/testdata/message-blocks-schema.json")
	}
}
