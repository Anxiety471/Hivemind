// Package integrationsetup ports integrationSetup.get (apps/api/src/routes/onboarding.ts:82):
// this deployment never offers integration setup, but the client still receives the page URL
// built from WEB_ORIGIN.
package integrationsetup

import (
	"context"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// State is IntegrationSetupStateSchema.
type State struct {
	CanConfigure bool       `json:"canConfigure"`
	NeedsSetup   bool       `json:"needsSetup"`
	WebURL       string     `json:"webUrl"`
	Providers    []Provider `json:"providers"`
}

// Provider is one configured integration provider; this deployment's list is always empty,
// but the field keeps the contract's non-null array shape.
type Provider struct {
	ID         string `json:"id"`
	Configured bool   `json:"configured"`
}

// Get implements integrationSetup.get: a constant state whose link is
// new URL("/integrations/setup", env.webOrigin).toString().
func Get(_ context.Context, deployment shared.Deployment, _ db.Actor, _ orpc.Input) (any, *orpc.Error) {
	link, err := whatwgurl.ParseRef("/integrations/setup", deployment.WebOrigin)
	if err != nil {
		return nil, shared.Failure(err)
	}
	return State{CanConfigure: false, NeedsSetup: false, WebURL: link.Href(), Providers: []Provider{}}, nil
}
