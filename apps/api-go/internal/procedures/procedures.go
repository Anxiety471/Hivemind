// Package procedures lists the procedures this build serves locally.
package procedures

import (
	"context"
	"log/slog"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/availability"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/botsections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/pages"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spendinglimit"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/trustedlinksites"
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
				parsed, failure := availability.ParseSet(input)
				if failure != nil {
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
				parsed, failure := availability.ParseChoose(input)
				if failure != nil {
					return nil, failure
				}
				if failure := availability.ChooseForSpace(ctx, database, actor, parsed); failure != nil {
					return nil, failure
				}
				return map[string]any{"ok": true}, nil
			},
		},
		{
			Name:     "trustedLinkSites.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return trustedlinksites.List(ctx, database, actor)
			},
		},
		{
			Name: "trustedLinkSites.remove",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return trustedlinksites.Remove(ctx, database, actor, input)
			},
		},
		{
			Name:     "spendingLimit.payments",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return spendinglimit.Payments(ctx, database, actor)
			},
		},
		{
			Name:     "spendingLimit.get",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return spendinglimit.Get(ctx, database, actor, slog.Default())
			},
		},
		{
			Name:     "botSections.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return botsections.List(ctx, database, actor)
			},
		},
		{
			Name:     "pages.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return pages.List(ctx, database, actor, input)
			},
		},
	}
}
