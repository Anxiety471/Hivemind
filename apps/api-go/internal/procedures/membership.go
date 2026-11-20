package procedures

import (
	"context"
	"log/slog"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/organizations"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spaces"
)

// membership lists the Space and organization procedures: who belongs where, and the
// invitations that bring people in. Writes record their own audit event, as the TypeScript
// handlers call recordAuditEvent themselves.
//
// organizations.members.list builds each invitation's link from WEB_ORIGIN; for an origin
// JoinURL does not normalise (a non-ASCII host, credentials) it is not served, so it stays on
// TypeScript rather than answering 500.
func membership(database *db.DB, deployment shared.Deployment, audit *effects.Recorder) []local.Procedure {
	procedures := []local.Procedure{
		{
			Name: "spaces.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.Rename(ctx, database, audit, actor, input)
			},
		},
		{
			Name:     "spaces.members.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.MembersList(ctx, database, actor, input)
			},
		},
		{
			Name: "spaces.members.add",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.MembersAdd(ctx, database, audit, actor, input)
			},
		},
		{
			Name:     "spaces.invites.preview",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.InvitesPreview(ctx, database, actor, input)
			},
		},
		{
			Name: "spaces.invites.accept",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.InvitesAccept(ctx, database, audit, actor, input)
			},
		},
		{
			Name: "spaces.invites.cancel",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return spaces.InvitesCancel(ctx, database, audit, actor, input)
			},
		},
		{
			Name:     "organizations.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				return organizations.ListMine(ctx, database, actor)
			},
		},
		{
			Name: "organizations.members.setRole",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return organizations.SetRole(ctx, database, deployment, audit, actor, input)
			},
		},
		{
			Name: "organizations.invitations.cancel",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return organizations.CancelInvitation(ctx, database, deployment, audit, actor, input)
			},
		},
		{
			Name: "organizations.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return organizations.Rename(ctx, database, audit, actor, input)
			},
		},
		{
			Name:     "organizations.invitations.preview",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				return organizations.InvitationsPreview(ctx, database, deployment, actor, input)
			},
		},
	}
	if _, err := shared.JoinURL(deployment.WebOrigin, "/join/probe"); err != nil {
		slog.Warn("organizations.members.list is not served: WEB_ORIGIN is not a plain http(s)://host[:port] origin",
			"web_origin", deployment.WebOrigin)
		return procedures
	}
	return append(procedures, local.Procedure{
		Name:     "organizations.members.list",
		ReadOnly: true,
		Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
			return organizations.MembersList(ctx, database, deployment, actor, input)
		},
	})
}
