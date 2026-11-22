// Package drivefiles exposes the Space Drive `files.*` and legacy `artifacts.*`
// oRPC procedures backed by internal/drive.
package drivefiles

import (
	"context"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/drive"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func decodeID(raw string, label string) (string, *orpc.Error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 128 {
		return "", orpc.InvalidInput(map[string]any{"message": "Invalid " + label})
	}
	return trimmed, nil
}

// Procedures builds the local.Procedure entries for Space Drive and legacy artifacts mutations.
func Procedures(svc *drive.Service) []local.Procedure {
	ok := map[string]any{"ok": true}
	return []local.Procedure{
		{
			Name:     "files.list",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req drive.ListInput
				if input.HasInput() {
					if failure := input.DecodeInto(&req); failure != nil {
						return nil, failure
					}
				}
				return svc.List(ctx, actor, req)
			},
		},
		{
			Name:     "files.get",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID string `json:"fileId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				return svc.GetFile(ctx, actor, id)
			},
		},
		{
			Name:     "files.folderTree",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				folders, failure := svc.FolderTree(ctx, actor)
				if failure != nil {
					return nil, failure
				}
				return map[string]any{"folders": folders}, nil
			},
		},
		{
			Name:     "files.changes",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					Cursor string `json:"cursor"`
					Limit  int    `json:"limit"`
				}
				if input.HasInput() {
					if failure := input.DecodeInto(&req); failure != nil {
						return nil, failure
					}
				}
				return svc.Changes(ctx, actor, req.Cursor, req.Limit)
			},
		},
		{
			Name: "files.createFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					ParentID *string `json:"parentId"`
					Name     string  `json:"name"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				return svc.CreateFolder(ctx, actor, req.ParentID, req.Name)
			},
		},
		{
			Name: "files.renameFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FolderID string `json:"folderId"`
					Name     string `json:"name"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FolderID, "folderId")
				if failure != nil {
					return nil, failure
				}
				return svc.RenameFolder(ctx, actor, id, req.Name)
			},
		},
		{
			Name: "files.moveFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FolderID string  `json:"folderId"`
					ParentID *string `json:"parentId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FolderID, "folderId")
				if failure != nil {
					return nil, failure
				}
				return svc.MoveFolder(ctx, actor, id, req.ParentID)
			},
		},
		{
			Name: "files.trashFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FolderID string `json:"folderId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FolderID, "folderId")
				if failure != nil {
					return nil, failure
				}
				if failure := svc.TrashFolder(ctx, actor, id); failure != nil {
					return nil, failure
				}
				return ok, nil
			},
		},
		{
			Name: "files.restoreFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FolderID string `json:"folderId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FolderID, "folderId")
				if failure != nil {
					return nil, failure
				}
				return svc.RestoreFolder(ctx, actor, id)
			},
		},
		{
			Name: "files.deleteFolder",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FolderID string `json:"folderId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FolderID, "folderId")
				if failure != nil {
					return nil, failure
				}
				if failure := svc.DeleteFolderPermanent(ctx, actor, id); failure != nil {
					return nil, failure
				}
				return ok, nil
			},
		},
		{
			Name: "files.rename",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID string `json:"fileId"`
					Name   string `json:"name"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				return svc.RenameFile(ctx, actor, id, req.Name)
			},
		},
		{
			Name: "files.move",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID   string  `json:"fileId"`
					FolderID *string `json:"folderId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				return svc.MoveFile(ctx, actor, id, req.FolderID)
			},
		},
		{
			Name: "files.trash",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID string `json:"fileId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				if failure := svc.TrashFile(ctx, actor, id); failure != nil {
					return nil, failure
				}
				return ok, nil
			},
		},
		{
			Name: "files.restore",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID string `json:"fileId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				return svc.RestoreFile(ctx, actor, id)
			},
		},
		{
			Name: "files.deletePermanent",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					FileID string `json:"fileId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.FileID, "fileId")
				if failure != nil {
					return nil, failure
				}
				if failure := svc.DeleteFilePermanent(ctx, actor, id); failure != nil {
					return nil, failure
				}
				return ok, nil
			},
		},
		{
			Name: "files.emptyTrash",
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				deleted, failure := svc.EmptyTrash(ctx, actor)
				if failure != nil {
					return nil, failure
				}
				return map[string]any{"ok": true, "deletedFiles": deleted}, nil
			},
		},
		{
			Name: "artifacts.create",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req drive.LegacyArtifactCreateInput
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				if (req.BotID == nil || strings.TrimSpace(*req.BotID) == "") && (req.GroupID == nil || strings.TrimSpace(*req.GroupID) == "") {
					return nil, orpc.InvalidInput(map[string]any{"message": "botId or groupId is required"})
				}
				return svc.CreateBase64Artifact(ctx, actor, req)
			},
		},
		{
			Name:     "artifacts.get",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					BotID      *string `json:"botId"`
					GroupID    *string `json:"groupId"`
					ArtifactID string  `json:"artifactId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.ArtifactID, "artifactId")
				if failure != nil {
					return nil, failure
				}
				return svc.GetBase64Artifact(ctx, actor, id, req.BotID, req.GroupID)
			},
		},
		{
			Name:     "artifacts.getById",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					ArtifactID string `json:"artifactId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.ArtifactID, "artifactId")
				if failure != nil {
					return nil, failure
				}
				return svc.GetBase64Artifact(ctx, actor, id, nil, nil)
			},
		},
		{
			Name: "artifacts.remove",
			Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
				if svc == nil {
					return nil, orpc.Unavailable()
				}
				var req struct {
					ArtifactID string `json:"artifactId"`
				}
				if failure := input.DecodeInto(&req); failure != nil {
					return nil, failure
				}
				id, failure := decodeID(req.ArtifactID, "artifactId")
				if failure != nil {
					return nil, failure
				}
				if failure := svc.DeleteFilePermanent(ctx, actor, id); failure != nil {
					return nil, failure
				}
				return ok, nil
			},
		},
	}
}
