package connections

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func in(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

// parseRename mirrors z.object({ connectionId: Id, displayName: z.string().trim().min(1).max(80) }).
func TestRenameInputIsZodExact(t *testing.T) {
	id, name, failure := parseRename(in(`{"connectionId":"c","displayName":"  Named \t","more":1}`))
	if failure != nil || id != "c" || name != "Named" {
		t.Fatalf("parse = %q %q %v", id, name, failure)
	}
	// Length is counted before the trim, in code points.
	if _, _, failure := parseRename(in(`{"connectionId":"c","displayName":"` + strings.Repeat("😀", 80) + `"}`)); failure != nil {
		t.Errorf("80 characters pass: %v", failure)
	}
	for _, text := range []string{
		`{"connectionId":"c","displayName":"` + strings.Repeat("😀", 81) + `"}`,
		`{"connectionId":"","displayName":"x"}`,
		`{"connectionId":5,"displayName":"x"}`,
		`{"displayName":"x"}`,
		`{"connectionId":"c"}`,
		`{"connectionId":"c","displayName":null}`,
		`{}`,
		`[]`,
		`null`,
	} {
		if _, _, failure := parseRename(in(text)); failure == nil {
			t.Errorf("%.60s should be rejected", text)
		}
	}
}
