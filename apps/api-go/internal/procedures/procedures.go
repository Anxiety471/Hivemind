// Package procedures lists the procedures this build serves locally.
package procedures

import (
	"context"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/availability"
)

// All returns every locally served procedure.
func All(database *db.DB) []local.Procedure {
	return []local.Procedure{
		{
			Name:     "availability.items",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return availability.Items(ctx, database, actor)
			},
		},
		{
			Name: "availability.set",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				var parsed availability.SetInput
				if failure := input.DecodeInto(&parsed); failure != nil {
					return nil, failure
				}
				result, failure := availability.Set(ctx, database, actor, parsed)
				if failure != nil {
					return nil, failure
				}
				return result, nil
			},
		},
		{
			Name: "availability.chooseForSpace",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				var parsed availability.ChooseInput
				if failure := input.DecodeInto(&parsed); failure != nil {
					return nil, failure
				}
				if failure := availability.ChooseForSpace(ctx, database, actor, parsed); failure != nil {
					return nil, failure
				}
				return map[string]any{"ok": true}, nil
			},
		},
	}
}
