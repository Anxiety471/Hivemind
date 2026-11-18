// Package procedures lists the procedures this build serves locally.
package procedures

import (
	"context"
	"log/slog"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/approvalrules"
	artifacts "github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/artifactlist"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/availability"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/botsections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/capabilities"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/computer"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/connections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/externalconversations"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/mcpassignments"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messaging"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/models"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/pages"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/scratchpad"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spendinglimit"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/threads"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/trustedlinksites"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/usage"
)

// All returns every locally served procedure.
func All(database *db.DB, deployment shared.Deployment) []local.Procedure {
	procedures := []local.Procedure{
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
		{
			Name: "spendingLimit.set",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spendinglimit.Set(ctx, database, actor, input, slog.Default())
			},
		},
		{
			Name: "botSections.create",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return botsections.Create(ctx, database, actor, input)
			},
		},
		{
			Name: "botSections.update",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return botsections.Update(ctx, database, actor, input)
			},
		},
		{
			Name: "botSections.remove",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return botsections.Remove(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.link.start",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.LinkStart(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.identities.setBot",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.SetBot(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.identities.unlink",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.Unlink(ctx, database, actor, input)
			},
		},
		{
			Name:     "messaging.channels.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.ChannelsList(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.channels.respond",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.ChannelsRespond(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.channels.leave",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.ChannelsLeave(ctx, database, actor, input)
			},
		},
		{
			Name:     "messaging.connections.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.ConnectionsList(ctx, database, actor, input)
			},
		},
		{
			Name: "messaging.connections.revoke",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return messaging.ConnectionsRevoke(ctx, database, actor, input)
			},
		},
		{
			Name:     "threads.head",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return threads.Head(ctx, database, actor, input)
			},
		},
		{
			Name: "threads.markRead",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return threads.MarkRead(ctx, database, actor, input)
			},
		},
		{
			Name: "threads.markUnread",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return threads.MarkUnread(ctx, database, actor, input)
			},
		},
		{
			Name: "threads.snooze",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return threads.Snooze(ctx, database, actor, input)
			},
		},
		{
			Name: "externalConversations.updatePolicy",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return externalconversations.UpdatePolicy(ctx, database, actor, input)
			},
		},
		{
			Name:     "scratchpad.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return scratchpad.List(ctx, database, actor, input)
			},
		},
		{
			Name: "scratchpad.create",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return scratchpad.Create(ctx, database, actor, input)
			},
		},
		{
			Name: "scratchpad.update",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return scratchpad.Update(ctx, database, actor, input)
			},
		},
		{
			Name: "scratchpad.remove",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return scratchpad.Remove(ctx, database, actor, input)
			},
		},
		{
			Name:     "approvalRules.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return approvalrules.List(ctx, database, actor, input)
			},
		},
		{
			Name: "approvalRules.set",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return approvalrules.Set(ctx, database, actor, input)
			},
		},
		{
			Name:     "spaceSettings.overrides",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return spacesettings.Overrides(ctx, database, actor)
			},
		},
		{
			Name:     "connections.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return connections.List(ctx, database, actor)
			},
		},
		{
			Name: "connections.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return connections.Rename(ctx, database, actor, input)
			},
		},
		{
			Name:     "capabilities.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return capabilities.List(ctx, database, actor, slog.Default())
			},
		},
		{
			Name:     "usage.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return usage.List(ctx, database, actor)
			},
		},
		{
			Name:     "usage.summary",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return usage.SummaryOf(ctx, database, actor)
			},
		},
		{
			Name:     "computer.updates",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return computer.Updates(ctx, database, actor)
			},
		},
		{
			Name:     "mcp.assignments.all",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return mcpassignments.All(ctx, database, actor)
			},
		},
		{
			Name:     "mcp.assignments.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return mcpassignments.List(ctx, database, actor, input)
			},
		},
		{
			Name:     "models.backups",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return models.Backups(ctx, database, actor)
			},
		},
		{
			Name: "models.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return models.Rename(ctx, database, actor, input)
			},
		},
		{
			Name: "pages.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return pages.Rename(ctx, database, actor, input)
			},
		},
		{
			Name: "pages.pin",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return pages.Pin(ctx, database, actor, input)
			},
		},
		{
			Name:     "artifacts.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return artifacts.List(ctx, database, actor, input)
			},
		},
		{
			Name:     "artifacts.listSpace",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return artifacts.ListSpace(ctx, database, actor, input)
			},
		},
		{
			Name:     "artifacts.listVersions",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return artifacts.ListVersions(ctx, database, actor, input)
			},
		},
	}
	return append(procedures, membership(database, deployment, effects.NewRecorder(database, slog.Default()))...)
}
