package main

import (
	"context"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/drive"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/memoryroam"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

const (
	driveOrganizerMaxTokens = 512
	driveOrganizerTimeout   = 45 * time.Second
)

type roamCompleterAdapter struct {
	client *memoryroam.Client
}

func (a roamCompleterAdapter) Complete(ctx context.Context, system, prompt string) (string, error) {
	text, _, err := a.client.Complete(ctx, system, prompt)
	return text, err
}

func newMainModelResolver(database *db.DB, deployment shared.Deployment) drive.CompleterResolver {
	return func(ctx context.Context, actor db.Actor) ([]drive.ModelCompleter, error) {
		if database == nil || deployment.Vault == nil {
			return nil, nil
		}
		connections, err := modelcredentials.ResolveMainConnections(ctx, database, deployment, actor)
		if err != nil {
			return nil, err
		}
		out := make([]drive.ModelCompleter, 0, len(connections))
		for _, conn := range connections {
			client, createErr := memoryroam.NewClient(memoryroam.ModelConfig{
				Style:     conn.Style,
				BaseURL:   conn.BaseURL,
				Model:     conn.ModelID,
				APIKey:    conn.APIKey,
				Headers:   conn.Headers,
				MaxTokens: driveOrganizerMaxTokens,
				Timeout:   driveOrganizerTimeout,
			})
			if createErr != nil {
				continue
			}
			out = append(out, roamCompleterAdapter{client: client})
		}
		return out, nil
	}
}
