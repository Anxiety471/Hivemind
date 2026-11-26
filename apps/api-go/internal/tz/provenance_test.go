package tz_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// TestNodeVersionProvenance pins the embedded zone data to the runtime that
// production serves the TypeScript side with. The gateway's offsets must equal
// production Node's Intl offsets, so when production's tz data moves (a new
// process.versions.tz) the zoneinfo.zip must be regenerated; silently running
// on the old release is the defect this pin exists to prevent.
func TestNodeVersionProvenance(t *testing.T) {
	if tz.Version != "2026e" {
		t.Fatalf("embedded tzdata is %s", tz.Version)
	}
	raw, err := os.ReadFile("zoneinfo.zip")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	if got := hex.EncodeToString(digest[:]); got != tz.ZoneinfoSHA256 {
		t.Fatalf("zoneinfo.zip sha256 is %s, tzdata_gen.go pins %s: the embedded zone data was edited outside genzones", got, tz.ZoneinfoSHA256)
	}

	node := provenanceNode(t)
	out, err := exec.Command(node, "-p", "JSON.stringify(process.versions)").Output()
	if err != nil {
		t.Fatalf("run %s to inspect process.versions: %v", node, err)
	}
	var got struct {
		Node string `json:"node"`
		ICU  string `json:"icu"`
		TZ   string `json:"tz"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("parse process.versions from %s: %v", node, err)
	}
	if got.Node != tz.NodeVersion || got.ICU != tz.ICUVersion || got.TZ != tz.Version {
		t.Fatalf("node at %s reports Node %s, ICU %s and tzdata %s; zoneinfo.zip is built from IANA tzdata %s and pinned to Node %s / ICU %s. The TypeScript side would compute different offsets for every zone this release changed. To fix: rebuild the embedded zones and the offset corpus with the production runtime: cd apps/api-go && go generate ./internal/tz && /home/hitori/.local/opt/node24/bin/node tools/tz-offset-corpus.mjs",
			node, got.Node, got.ICU, got.TZ, tz.Version, tz.NodeVersion, tz.ICUVersion)
	}
}

// provenanceNode is the node the gateway is compared against: an explicit
// RAKAZO_NODE, else the user-local Node 24 path production runs. A host without
// that path skips, because the comparison has nothing to run; a path that
// exists but cannot be executed fails, because the pin must be enforced where
// production's runtime is installed. PATH is not a fallback: another node's ICU
// would fail the pin for an environment reason.
func provenanceNode(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("RAKAZO_NODE"); path != "" {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("RAKAZO_NODE=%q is not available: %v", path, err)
		}
		return path
	}
	pinned := filepath.Join(os.Getenv("HOME"), ".local", "opt", "node24", "bin", "node")
	if _, err := os.Stat(pinned); err == nil {
		return pinned
	}
	t.Skip("production Node is not installed at " + pinned + " (set RAKAZO_NODE to compare against another runtime)")
	return ""
}

// goOffset is a zone's offset from UTC, in seconds, at an instant.
func goOffset(t *testing.T, location *time.Location, instant int64) int64 {
	t.Helper()
	_, offset := time.UnixMilli(instant).In(location).Zone()
	return int64(offset)
}
