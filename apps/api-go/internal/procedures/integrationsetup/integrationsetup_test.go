package integrationsetup

import (
	"context"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

func TestGetBuildsTheSetupLinkFromTheOrigin(t *testing.T) {
	for origin, want := range map[string]string{
		"https://app.example.test":       "https://app.example.test/integrations/setup",
		"http://127.0.0.1:5173":          "http://127.0.0.1:5173/integrations/setup",
		"https://APP.example.test/base/": "https://app.example.test/integrations/setup",
	} {
		value, failure := Get(context.Background(), shared.Deployment{WebOrigin: origin}, db.Actor{}, orpc.Input{})
		if failure != nil {
			t.Errorf("Get(%q) failed: %+v", origin, failure)
			continue
		}
		state := value.(State)
		if state.WebURL != want || state.CanConfigure || state.NeedsSetup || state.Providers == nil {
			t.Errorf("Get(%q) = %+v, want webUrl %q and empty providers", origin, state, want)
		}
	}
}
