// Package drive implements Rakazo's Space Drive backend: streaming encrypted
// uploads, byte-range content playback, folder hierarchy operations, Trash,
// Phase 4-ready delta change feeds, and legacy artifacts.* parity.
package drive

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filepolicy"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filestore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxFolderDepth = 20
	sniffBytes     = 1024
)

var (
	validSources = map[string]bool{
		"upload":    true,
		"chat":      true,
		"bot":       true,
		"email":     true,
		"messaging": true,
	}
	codeMIMETypeList = []string{
		"application/x-sh", "application/javascript", "application/json", "application/xml",
		"application/yaml", "application/toml", "application/sql", "application/x-httpd-php",
		"text/html", "text/css", "text/typescript",
		"text/x-python", "text/x-go", "text/x-rust", "text/x-c", "text/x-c++",
		"text/x-java", "text/x-ruby", "text/x-swift", "text/x-kotlin", "text/x-diff",
	}
	archiveMIMETypeList = []string{
		"application/zip", "application/vnd.rar", "application/x-7z-compressed",
		"application/gzip", "application/x-tar", "application/x-bzip2", "application/x-xz",
	}
	documentMIMETypeList = []string{
		"application/pdf", "application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/rtf", "application/vnd.oasis.opendocument.text",
		"application/vnd.oasis.opendocument.spreadsheet",
		"text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
	}
)

// FileFolder matches packages/contracts/src/artifacts/files.ts FileFolderSchema.
type FileFolder struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parentId"`
	BotID     *string `json:"botId"`
	Name      string  `json:"name"`
	TrashedAt *string `json:"trashedAt"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// FolderBreadcrumb matches FolderBreadcrumbSchema.
type FolderBreadcrumb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// DriveFile matches DriveFileSchema.
type DriveFile struct {
	ID           string  `json:"id"`
	BotID        *string `json:"botId"`
	GroupID      *string `json:"groupId"`
	RunID        *string `json:"runId"`
	FolderID     *string `json:"folderId"`
	Source       string  `json:"source"`
	Name         string  `json:"name"`
	Slug         *string `json:"slug"`
	Description  *string `json:"description"`
	MimeType     string  `json:"mimeType"`
	Size         int64   `json:"size"`
	Hash         string  `json:"hash"`
	Version      int     `json:"version"`
	VersionCount int     `json:"versionCount"`
	TrashedAt    *string `json:"trashedAt"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
	ContentURL   string  `json:"contentUrl"`
}

// DriveFolderTreeEntry matches DriveFolderTreeEntrySchema.
type DriveFolderTreeEntry struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	BotID    *string `json:"botId"`
	Name     string  `json:"name"`
}

// DriveChangeItem matches DriveChangeItemSchema (Phase 4 delta feed).
type DriveChangeItem struct {
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	ParentID  *string `json:"parentId"`
	Name      string  `json:"name"`
	TrashedAt *string `json:"trashedAt"`
	UpdatedAt string  `json:"updatedAt"`
	Hash      *string `json:"hash"`
	Size      *int64  `json:"size"`
	MimeType  *string `json:"mimeType"`
	Version   *int    `json:"version"`
}

// ContentMeta carries file headers needed to serve HTTP GET/HEAD/Range without buffering.
type ContentMeta struct {
	ID         string
	Name       string
	MimeType   string
	Size       int64
	Hash       string
	StorageKey string
}

// UploadParams holds validated metadata for UploadStream.
type UploadParams struct {
	FolderID    *string
	BotID       *string
	GroupID     *string
	RunID       *string
	Source      string
	Name        string
	Slug        *string
	Description *string
	MimeType    string
	ClientNonce *string
}

// UpdateFileInput carries optional mutations for files.update.
type UpdateFileInput struct {
	FileID         string
	Name           *string
	HasDescription bool
	Description    *string
	HasSlug        bool
	Slug           *string
}

// ListInput filters files.list queries.
type ListInput struct {
	FolderID   *string `json:"folderId"`
	AllFolders bool    `json:"allFolders"`
	BotID      *string `json:"botId"`
	MadeByBots bool    `json:"madeByBots"`
	Category   string  `json:"category"`
	Query      string  `json:"query"`
	Trashed    bool    `json:"trashed"`
	SortBy     string  `json:"sortBy"`
	SortDir    string  `json:"sortDir"`
	Cursor     string  `json:"cursor"`
	Limit      int     `json:"limit"`
}

// ListResult matches files.list output.
type ListResult struct {
	Breadcrumbs []FolderBreadcrumb `json:"breadcrumbs"`
	Folders     []FileFolder       `json:"folders"`
	Files       []DriveFile        `json:"files"`
	NextCursor  *string            `json:"nextCursor"`
}

// ChangesResult matches files.changes output.
type ChangesResult struct {
	Items      []DriveChangeItem `json:"items"`
	NextCursor *string           `json:"nextCursor"`
	HasMore    bool              `json:"hasMore"`
}

// LegacyArtifactCreateInput matches artifacts.create input (threadTarget + contentBase64).
type LegacyArtifactCreateInput struct {
	BotID         *string `json:"botId"`
	GroupID       *string `json:"groupId"`
	FolderID      *string `json:"folderId"`
	Source        string  `json:"source"`
	Name          string  `json:"name"`
	Slug          *string `json:"slug"`
	Description   *string `json:"description"`
	MimeType      string  `json:"mimeType"`
	ContentBase64 string  `json:"contentBase64"`
	ClientNonce   *string `json:"clientNonce"`
}

// LegacyArtifact matches packages/contracts/src/artifacts/artifacts.ts ArtifactSchema.
type LegacyArtifact struct {
	ID          string  `json:"id"`
	BotID       *string `json:"botId"`
	GroupID     *string `json:"groupId"`
	RunID       *string `json:"runId"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	MimeType    string  `json:"mimeType"`
	Size        int64   `json:"size"`
	Version     int     `json:"version"`
	CreatedAt   string  `json:"createdAt"`
}

// LegacyArtifactContent matches ArtifactWithContentSchema for artifacts.get / getById.
type LegacyArtifactContent struct {
	LegacyArtifact
	ContentBase64 string `json:"contentBase64"`
}

// Service implements Space Drive and streaming artifact operations.
type Service struct {
	db             *db.DB
	store          filestore.Store
	signals        *effects.Notifier
	organizer      *Organizer
	maxFileBytes   int64
	maxLegacyBytes int64
	logger         *slog.Logger
}

// SetOrganizer attaches a background upload organizer to the Drive service.
func (s *Service) SetOrganizer(organizer *Organizer) {
	s.organizer = organizer
}

// Wait blocks until any in-flight background upload organization jobs finish.
func (s *Service) Wait() {
	if s != nil && s.organizer != nil {
		s.organizer.Wait()
	}
}

// NewService constructs a Drive Service.
func NewService(
	database *db.DB,
	store filestore.Store,
	signals *effects.Notifier,
	maxFileBytes int64,
	maxLegacyBytes int64,
	logger *slog.Logger,
) *Service {
	if maxFileBytes <= 0 {
		maxFileBytes = filepolicy.DefaultFileUploadMaxBytes
	}
	if maxLegacyBytes <= 0 {
		maxLegacyBytes = filepolicy.LegacyAttachmentMaxBytes
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		db:             database,
		store:          store,
		signals:        signals,
		maxFileBytes:   maxFileBytes,
		maxLegacyBytes: maxLegacyBytes,
		logger:         logger,
	}
}

func (s *Service) MaxFileBytes() int64 { return s.maxFileBytes }

func formatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func formatOptTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	formatted := formatTime(*t)
	return &formatted
}

func contentURLFor(id string) string {
	return "/api/v1/files/" + url.PathEscape(id) + "/content"
}

func trimOpt(v *string) *string {
	if v == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*v)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func mapPgErr(err error, conflictMsg string) *orpc.Error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return orpc.Conflict(conflictMsg)
	}
	return nil
}

func normalizeFilename(raw string) string {
	cleaned := strings.ReplaceAll(raw, "\\", "/")
	base := path.Base(cleaned)
	if base == "." || base == "/" || strings.TrimSpace(base) == "" {
		return "upload"
	}
	return base
}

func (s *Service) publishFilesChange(spaceID string) {
	if s.signals != nil && spaceID != "" {
		s.signals.PublishSpaceChange(spaceID, "files")
	}
}

func isHiddenDriveMime(mimeType string) bool {
	return mimeType == "text/html;profile=mcp-app" || strings.HasSuffix(mimeType, ";profile=step-screenshot")
}

func ensureBotFolderTx(ctx context.Context, tx pgx.Tx, spaceID, userID, botID string) (string, error) {
	if spaceID == "" || botID == "" {
		return "", nil
	}
	var existingID string
	err := tx.QueryRow(ctx, `
		SELECT id FROM "file_folders"
		WHERE "spaceId" = $1 AND "botId" = $2 AND "trashedAt" IS NULL
		LIMIT 1
	`, spaceID, botID).Scan(&existingID)
	if err == nil {
		return existingID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	var botName string
	err = tx.QueryRow(ctx, `
		SELECT name FROM "bots" WHERE id = $1 AND "spaceId" = $2 LIMIT 1
	`, botID, spaceID).Scan(&botName)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}

	baseName := filepolicy.SanitizeFolderName(botName, "Bot")
	var adoptID string
	adoptLookupErr := tx.QueryRow(ctx, `
		SELECT id FROM "file_folders"
		WHERE "spaceId" = $1
		  AND "parentId" IS NULL
		  AND "botId" IS NULL
		  AND "trashedAt" IS NULL
		  AND LOWER(name) = LOWER($2)
		LIMIT 1
	`, spaceID, baseName).Scan(&adoptID)
	if adoptLookupErr == nil {
		if _, spErr := tx.Exec(ctx, `SAVEPOINT sp_bot_adopt`); spErr != nil {
			return "", spErr
		}
		tag, updErr := tx.Exec(ctx, `
			UPDATE "file_folders"
			SET "botId" = $2, "updatedAt" = NOW()
			WHERE id = $1 AND "botId" IS NULL AND "trashedAt" IS NULL
		`, adoptID, botID)
		if updErr == nil {
			if _, relErr := tx.Exec(ctx, `RELEASE SAVEPOINT sp_bot_adopt`); relErr != nil {
				return "", relErr
			}
			if tag.RowsAffected() > 0 {
				return adoptID, nil
			}
		} else {
			_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_bot_adopt`)
			var pgErr *pgconn.PgError
			if !errors.As(updErr, &pgErr) || pgErr.Code != "23505" {
				return "", updErr
			}
		}
		if rErr := tx.QueryRow(ctx, `
			SELECT id FROM "file_folders"
			WHERE "spaceId" = $1 AND "botId" = $2 AND "trashedAt" IS NULL
			LIMIT 1
		`, spaceID, botID).Scan(&existingID); rErr == nil {
			return existingID, nil
		}
	} else if !errors.Is(adoptLookupErr, pgx.ErrNoRows) {
		return "", adoptLookupErr
	}

	prefixRunes := []rune(baseName)
	if len(prefixRunes) > 240 {
		prefixRunes = prefixRunes[:240]
	}
	prefix := strings.TrimSpace(string(prefixRunes))
	if prefix == "" {
		prefix = "Bot"
	}

	for attempt := 1; attempt <= 10; attempt++ {
		candidate := baseName
		if attempt > 1 {
			candidate = fmt.Sprintf("%s (%d)", prefix, attempt)
		}
		newID := effects.NewID()
		if _, spErr := tx.Exec(ctx, `SAVEPOINT sp_bot_folder`); spErr != nil {
			return "", spErr
		}
		_, insErr := tx.Exec(ctx, `
			INSERT INTO "file_folders" (id, "spaceId", "parentId", "botId", "createdByUserId", name, "createdAt", "updatedAt")
			VALUES ($1, $2, NULL, $3, $4, $5, NOW(), NOW())
		`, newID, spaceID, botID, userID, candidate)
		if insErr == nil {
			if _, relErr := tx.Exec(ctx, `RELEASE SAVEPOINT sp_bot_folder`); relErr != nil {
				return "", relErr
			}
			return newID, nil
		}
		_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_bot_folder`)
		var pgErr *pgconn.PgError
		if !errors.As(insErr, &pgErr) || pgErr.Code != "23505" {
			return "", insErr
		}
		if rErr := tx.QueryRow(ctx, `
			SELECT id FROM "file_folders"
			WHERE "spaceId" = $1 AND "botId" = $2 AND "trashedAt" IS NULL
			LIMIT 1
		`, spaceID, botID).Scan(&existingID); rErr == nil {
			return existingID, nil
		}
	}
	return "", nil
}

// UploadStream validates metadata and sniffed bytes, streams the upload to the
// encrypted blob store in constant memory, and inserts an Artifact record.
func (s *Service) UploadStream(ctx context.Context, actor db.Actor, params UploadParams, src io.Reader) (DriveFile, *orpc.Error) {
	if s.store == nil || s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}

	name, err := filepolicy.ValidateDriveName(normalizeFilename(params.Name))
	if err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	mimeType, err := filepolicy.InferMIME(name, params.MimeType)
	if err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	source := strings.TrimSpace(params.Source)
	if source == "" {
		source = "upload"
	}
	if !validSources[source] {
		return DriveFile{}, orpc.BadRequest("Invalid file source")
	}
	var desc *string
	if params.Description != nil {
		trimmed := strings.TrimSpace(*params.Description)
		if trimmed != "" {
			if len([]rune(trimmed)) > 280 {
				return DriveFile{}, orpc.BadRequest("Description exceeds 280 characters")
			}
			desc = &trimmed
		}
	}
	folderID := trimOpt(params.FolderID)
	hadExplicitFolder := folderID != nil
	botID := trimOpt(params.BotID)
	groupID := trimOpt(params.GroupID)
	runID := trimOpt(params.RunID)
	clientNonce := trimOpt(params.ClientNonce)
	var slug string
	if rawSlug := trimOpt(params.Slug); rawSlug != nil {
		normalizedSlug, slugErr := filepolicy.NormalizeSlug(*rawSlug)
		if slugErr != nil {
			return DriveFile{}, orpc.BadRequest(slugErr.Error())
		}
		slug = normalizedSlug
	} else {
		slug = filepolicy.SlugifyFilename(name)
	}

	// Peek header bytes to validate image/PDF magic signatures and prevent script polyglots
	// before streaming the whole upload.
	prefix := make([]byte, sniffBytes)
	pn, readErr := io.ReadFull(src, prefix)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return DriveFile{}, orpc.BadRequest("Could not read upload stream")
	}
	prefix = prefix[:pn]
	if err := filepolicy.SniffSafeUpload(mimeType, prefix); err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}

	// Pre-flight authorization / target validation in a quick transaction so we don't
	// hold a Postgres connection idle while receiving a large file stream.
	var existing *DriveFile
	var preErr *orpc.Error
	err = s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if clientNonce != nil {
			var found DriveFile
			var ok bool
			var findErr error
			found, ok, findErr = s.findByClientNonceTx(ctx, tx, actor, *clientNonce)
			if findErr != nil {
				return findErr
			}
			if ok {
				existing = &found
				return nil
			}
		}
		if folderID != nil {
			var active bool
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT TRUE, ("trashedAt" IS NULL) FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`,
				*folderID, actor.SpaceID).Scan(&exists, &active); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					preErr = orpc.NotFound("Folder not found")
					return nil
				}
				return err
			}
			if !active {
				preErr = orpc.BadRequest("Cannot upload into a trashed folder")
				return nil
			}
		}
		if botID != nil {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "bots" WHERE id = $1 AND "spaceId" = $2)`,
				*botID, actor.SpaceID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				preErr = orpc.NotFound("Bot not found")
				return nil
			}
		}
		if groupID != nil {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "chat_groups" WHERE id = $1 AND "spaceId" = $2)`,
				*groupID, actor.SpaceID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				preErr = orpc.NotFound("Group not found")
				return nil
			}
		}
		return nil
	})
	if err != nil {
		return DriveFile{}, orpc.Internal()
	}
	if preErr != nil {
		return DriveFile{}, preErr
	}
	if existing != nil {
		return *existing, nil
	}

	limitReader := &boundedStreamReader{
		r:   io.MultiReader(bytes.NewReader(prefix), src),
		max: s.maxFileBytes,
	}
	blob, err := s.store.PutStream(ctx, actor.SpaceID, limitReader)
	if err != nil {
		if errors.Is(err, errStreamTooLarge) {
			return DriveFile{}, orpc.TooLarge(fmt.Sprintf("File exceeds the %d MiB limit", s.maxFileBytes/(1024*1024)))
		}
		s.logger.Error("drive blob put failed", "error", err, "spaceId", actor.SpaceID)
		return DriveFile{}, orpc.Internal()
	}

	var created DriveFile
	var txFailure *orpc.Error
	var replayed bool
	err = s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if clientNonce != nil {
			found, ok, findErr := s.findByClientNonceTx(ctx, tx, actor, *clientNonce)
			if findErr != nil {
				return findErr
			}
			if ok {
				created = found
				replayed = true
				// Racing retry already persisted its own blob/row; remove the duplicate blob.
				_ = s.store.Remove(context.Background(), actor.SpaceID, blob.ID)
				return nil
			}
		}

		effectiveFolderID := folderID
		if effectiveFolderID == nil && source == "bot" && botID != nil && !isHiddenDriveMime(mimeType) {
			botFolderID, folderErr := ensureBotFolderTx(ctx, tx, actor.SpaceID, actor.UserID, *botID)
			if folderErr != nil {
				return folderErr
			}
			if botFolderID != "" {
				effectiveFolderID = &botFolderID
			}
		}

		// Lock and compute version family for active files matching (folderId, botId, name).
		var matchID string
		var matchRoot *string
		var matchErr error
		matchErr = tx.QueryRow(ctx, `
			SELECT id, "rootArtifactId"
			FROM "artifacts"
			WHERE "spaceId" = $1
			  AND COALESCE("folderId", '') = COALESCE($2, '')
			  AND COALESCE("botId", '') = COALESCE($3, '')
			  AND COALESCE("groupId", '') = COALESCE($5, '')
			  AND LOWER(name) = LOWER($4)
			  AND "trashedAt" IS NULL
			  AND standalone = false
			ORDER BY version DESC, "createdAt" DESC
			LIMIT 1
			FOR UPDATE
		`, actor.SpaceID, effectiveFolderID, botID, name, groupID).Scan(&matchID, &matchRoot)

		var rootID *string
		nextVersion := 1
		if matchErr == nil {
			rID := matchID
			if matchRoot != nil && *matchRoot != "" {
				rID = *matchRoot
			}
			rootID = &rID
			var rootLock string
			_ = tx.QueryRow(ctx, `SELECT id FROM "artifacts" WHERE id = $1 FOR UPDATE`, rID).Scan(&rootLock)
			var maxVer int
			if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
				actor.SpaceID, rID).Scan(&maxVer); err != nil {
				return err
			}
			nextVersion = maxVer + 1
		} else if !errors.Is(matchErr, pgx.ErrNoRows) {
			return matchErr
		}

		newID := effects.NewID()
		var createdAt, updatedAt time.Time
		var trashedAt *time.Time
		err := tx.QueryRow(ctx, `
			INSERT INTO "artifacts" (
				id, "spaceId", "botId", "groupId", "folderId", "userId", "runId",
				source, name, slug, description, "mimeType", size, hash, "storageKey",
				"rootArtifactId", version, standalone, "clientNonce", "createdAt", "updatedAt"
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7,
				$8, $9, $10, $11, $12, $13, $14, $15,
				$16, $17, false, $18, NOW(), NOW()
			)
			RETURNING "createdAt", "updatedAt", "trashedAt"
		`,
			db.Data(newID, actor.SpaceID, botID, groupID, effectiveFolderID, actor.UserID, runID,
				source, name, slug, desc, mimeType, int(blob.SizeBytes), blob.Hash, blob.ID,
				rootID, nextVersion, clientNonce)...,
		).Scan(&createdAt, &updatedAt, &trashedAt)
		if err != nil {
			if pgErr := mapPgErr(err, "Upload conflict"); pgErr != nil {
				txFailure = pgErr
				return nil
			}
			return err
		}

		created = DriveFile{
			ID:           newID,
			BotID:        botID,
			GroupID:      groupID,
			RunID:        runID,
			FolderID:     effectiveFolderID,
			Source:       source,
			Name:         name,
			Slug:         &slug,
			Description:  desc,
			MimeType:     mimeType,
			Size:         blob.SizeBytes,
			Hash:         blob.Hash,
			Version:      nextVersion,
			VersionCount: nextVersion,
			TrashedAt:    formatOptTime(trashedAt),
			CreatedAt:    formatTime(createdAt),
			UpdatedAt:    formatTime(updatedAt),
			ContentURL:   contentURLFor(newID),
		}
		return nil
	})
	if err != nil {
		_ = s.store.Remove(context.Background(), actor.SpaceID, blob.ID)
		s.logger.Error("drive artifact insert failed", "error", err, "spaceId", actor.SpaceID)
		return DriveFile{}, orpc.Internal()
	}
	if txFailure != nil {
		_ = s.store.Remove(context.Background(), actor.SpaceID, blob.ID)
		return DriveFile{}, txFailure
	}
	s.publishFilesChange(actor.SpaceID)
	if !replayed && s.organizer != nil && (source == "upload" || (source == "chat" && runID == nil)) {
		s.organizer.Enqueue(actor, created.ID, hadExplicitFolder)
	}
	return created, nil
}

func (s *Service) findByClientNonceTx(ctx context.Context, tx pgx.Tx, actor db.Actor, nonce string) (DriveFile, bool, error) {
	row := tx.QueryRow(ctx, `
		SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source, a.name, a.slug, a.description,
			   a."mimeType", a.size, a.hash, a.version, a."trashedAt", a."createdAt", a."updatedAt",
			   COALESCE(a."rootArtifactId", a.id) AS family_id
		FROM "artifacts" a
		WHERE a."spaceId" = $1 AND a."userId" = $2 AND a."clientNonce" = $3
		LIMIT 1
	`, actor.SpaceID, actor.UserID, nonce)
	f, familyID, err := scanDriveFile(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return DriveFile{}, false, nil
	}
	if err != nil {
		return DriveFile{}, false, err
	}
	var count int
	_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
		actor.SpaceID, familyID).Scan(&count)
	if count > f.VersionCount {
		f.VersionCount = count
	}
	return f, true, nil
}

var errStreamTooLarge = errors.New("stream exceeded max bytes")

type boundedStreamReader struct {
	r    io.Reader
	max  int64
	seen int64
}

func (b *boundedStreamReader) Read(p []byte) (int, error) {
	if b.seen > b.max {
		return 0, errStreamTooLarge
	}
	remaining := (b.max - b.seen) + 1
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := b.r.Read(p)
	b.seen += int64(n)
	if b.seen > b.max {
		return n, errStreamTooLarge
	}
	return n, err
}

// StatContent fetches file metadata (verifying tenancy and active non-trashed state).
func (s *Service) StatContent(ctx context.Context, actor db.Actor, fileID string) (ContentMeta, *orpc.Error) {
	if s.db == nil || s.store == nil {
		return ContentMeta{}, orpc.Unavailable()
	}
	var meta ContentMeta
	var size int
	var trashedAt *time.Time
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, name, "mimeType", size, hash, "storageKey", "trashedAt"
			FROM "artifacts"
			WHERE id = $1 AND "spaceId" = $2
		`, fileID, actor.SpaceID).Scan(&meta.ID, &meta.Name, &meta.MimeType, &size, &meta.Hash, &meta.StorageKey, &trashedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) || trashedAt != nil {
		return ContentMeta{}, orpc.NotFound("File not found")
	}
	if err != nil {
		s.logger.Error("stat content failed", "error", err, "fileId", fileID)
		return ContentMeta{}, orpc.Internal()
	}
	meta.Size = int64(size)
	return meta, nil
}

// OpenContent opens a streaming decrypted reader (optionally bounded to byteRange)
// along with metadata for HTTP headers.
func (s *Service) OpenContent(ctx context.Context, actor db.Actor, fileID string, byteRange *filestore.ByteRange) (ContentMeta, io.ReadCloser, int64, *orpc.Error) {
	meta, failure := s.StatContent(ctx, actor, fileID)
	if failure != nil {
		return ContentMeta{}, nil, 0, failure
	}
	rc, totalPlain, err := s.store.OpenStream(ctx, actor.SpaceID, meta.StorageKey, byteRange)
	if err != nil {
		if errors.Is(err, filestore.ErrInvalidRange) {
			return meta, nil, meta.Size, orpc.New("RANGE_NOT_SATISFIABLE", 416, "Requested range not satisfiable")
		}
		if errors.Is(err, filestore.ErrNotFound) {
			return ContentMeta{}, nil, 0, orpc.NotFound("File contents not found")
		}
		if errors.Is(err, contentcrypto.ErrDecryption) || errors.Is(err, contentcrypto.ErrAnotherSpace) || errors.Is(err, contentcrypto.ErrSpaceKeyMissing) {
			return ContentMeta{}, nil, 0, orpc.Forbidden("Encrypted file could not be decrypted")
		}
		s.logger.Error("open content stream failed", "error", err, "fileId", fileID)
		return ContentMeta{}, nil, 0, orpc.Internal()
	}
	meta.Size = totalPlain
	return meta, rc, totalPlain, nil
}

type listCursor struct {
	SortVal string `json:"k"`
	SizeVal int64  `json:"n,omitempty"`
	ID      string `json:"i"`
}

func encodeCursor(c listCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string) (listCursor, error) {
	var c listCursor
	if raw == "" {
		return c, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil || c.ID == "" {
		return c, errors.New("invalid cursor")
	}
	return c, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanDriveFile(s rowScanner) (DriveFile, string, error) {
	var f DriveFile
	var sizeInt int
	var trashedAt *time.Time
	var createdAt, updatedAt time.Time
	var familyID string
	err := s.Scan(
		&f.ID, &f.BotID, &f.GroupID, &f.RunID, &f.FolderID,
		&f.Source, &f.Name, &f.Slug, &f.Description, &f.MimeType, &sizeInt,
		&f.Hash, &f.Version, &trashedAt, &createdAt, &updatedAt,
		&familyID,
	)
	if err != nil {
		return DriveFile{}, "", err
	}
	f.Size = int64(sizeInt)
	f.VersionCount = f.Version
	f.TrashedAt = formatOptTime(trashedAt)
	f.CreatedAt = formatTime(createdAt)
	f.UpdatedAt = formatTime(updatedAt)
	f.ContentURL = contentURLFor(f.ID)
	return f, familyID, nil
}

// List implements files.list with breadcrumbs, child folders, filtered & sorted
// latest-version Drive files, and cursor pagination.
func (s *Service) List(ctx context.Context, actor db.Actor, input ListInput) (ListResult, *orpc.Error) {
	if s.db == nil {
		return ListResult{}, orpc.Unavailable()
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	sortBy := input.SortBy
	if sortBy == "" {
		sortBy = "updatedAt"
	}
	if sortBy != "updatedAt" && sortBy != "name" && sortBy != "size" {
		return ListResult{}, orpc.BadRequest("Invalid sortBy")
	}
	sortDir := input.SortDir
	if sortDir == "" {
		if sortBy == "name" {
			sortDir = "asc"
		} else {
			sortDir = "desc"
		}
	}
	if sortDir != "asc" && sortDir != "desc" {
		return ListResult{}, orpc.BadRequest("Invalid sortDir")
	}
	var cursor listCursor
	if input.Cursor != "" {
		var err error
		cursor, err = decodeCursor(input.Cursor)
		if err != nil {
			return ListResult{}, orpc.BadRequest("Invalid cursor")
		}
	}
	folderID := trimOpt(input.FolderID)
	queryStr := strings.TrimSpace(input.Query)
	category := strings.TrimSpace(input.Category)
	if category == "" {
		category = "all"
	}

	result := ListResult{
		Breadcrumbs: []FolderBreadcrumb{},
		Folders:     []FileFolder{},
		Files:       []DriveFile{},
	}
	var logicErr *orpc.Error
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if folderID != nil && !input.AllFolders && !input.Trashed {
			crumbs, fErr := s.loadBreadcrumbsTx(ctx, tx, actor.SpaceID, *folderID)
			if fErr != nil {
				logicErr = fErr
				return nil
			}
			result.Breadcrumbs = crumbs
		}

		// Load folders matching current view unless flat allFolders view is active
		// or user explicitly filtered to bot-only or a specific file category.
		if !input.AllFolders && category == "all" && input.BotID == nil && !input.MadeByBots && input.Cursor == "" {
			folders, err := s.listFoldersTx(ctx, tx, actor.SpaceID, folderID, queryStr, input.Trashed)
			if err != nil {
				return err
			}
			result.Folders = folders
		}

		files, nextCursor, fErr := s.listFilesTx(ctx, tx, actor.SpaceID, folderID, input, sortBy, sortDir, cursor, limit, queryStr, category)
		if fErr != nil {
			logicErr = fErr
			return nil
		}
		result.Files = files
		result.NextCursor = nextCursor
		return nil
	})
	if err != nil {
		s.logger.Error("files.list failed", "error", err, "spaceId", actor.SpaceID)
		return ListResult{}, orpc.Internal()
	}
	if logicErr != nil {
		return ListResult{}, logicErr
	}
	return result, nil
}

func (s *Service) loadBreadcrumbsTx(ctx context.Context, tx pgx.Tx, spaceID, folderID string) ([]FolderBreadcrumb, *orpc.Error) {
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE anc AS (
			SELECT id, "parentId", name, "trashedAt", 0 AS depth
			FROM "file_folders"
			WHERE id = $1 AND "spaceId" = $2
			UNION ALL
			SELECT f.id, f."parentId", f.name, f."trashedAt", anc.depth + 1
			FROM "file_folders" f
			JOIN anc ON f.id = anc."parentId"
			WHERE f."spaceId" = $2 AND anc.depth < 30
		)
		SELECT id, name, "trashedAt" FROM anc ORDER BY depth DESC
	`, folderID, spaceID)
	if err != nil {
		return nil, orpc.Internal()
	}
	defer rows.Close()

	var out []FolderBreadcrumb
	for rows.Next() {
		var b FolderBreadcrumb
		var trashed *time.Time
		if err := rows.Scan(&b.ID, &b.Name, &trashed); err != nil {
			return nil, orpc.Internal()
		}
		if trashed != nil {
			return nil, orpc.NotFound("Folder not found")
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, orpc.Internal()
	}
	if len(out) == 0 {
		return nil, orpc.NotFound("Folder not found")
	}
	return out, nil
}

func (s *Service) listFoldersTx(ctx context.Context, tx pgx.Tx, spaceID string, folderID *string, query string, trashed bool) ([]FileFolder, error) {
	var args []any
	args = append(args, spaceID)
	var conds []string
	conds = append(conds, `"spaceId" = $1`)
	if trashed {
		conds = append(conds, `"trashedAt" IS NOT NULL`)
	} else {
		conds = append(conds, `"trashedAt" IS NULL`)
		if folderID == nil {
			conds = append(conds, `"parentId" IS NULL`)
		} else {
			args = append(args, *folderID)
			conds = append(conds, fmt.Sprintf(`"parentId" = $%d`, len(args)))
		}
	}
	if query != "" {
		args = append(args, "%"+escapeLike(query)+"%")
		conds = append(conds, fmt.Sprintf(`name ILIKE $%d ESCAPE '\'`, len(args)))
	}

	sqlQuery := fmt.Sprintf(`
		SELECT id, "parentId", "botId", name, "trashedAt", "createdAt", "updatedAt"
		FROM "file_folders"
		WHERE %s
		ORDER BY LOWER(name) ASC, id ASC
	`, strings.Join(conds, " AND "))

	rows, err := tx.Query(ctx, sqlQuery, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FileFolder{}
	for rows.Next() {
		var f FileFolder
		var trashedAt *time.Time
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&f.ID, &f.ParentID, &f.BotID, &f.Name, &trashedAt, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		f.TrashedAt = formatOptTime(trashedAt)
		f.CreatedAt = formatTime(createdAt)
		f.UpdatedAt = formatTime(updatedAt)
		out = append(out, f)
	}
	return out, rows.Err()
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

func (s *Service) listFilesTx(
	ctx context.Context,
	tx pgx.Tx,
	spaceID string,
	folderID *string,
	input ListInput,
	sortBy, sortDir string,
	cursor listCursor,
	limit int,
	queryStr, category string,
) ([]DriveFile, *string, *orpc.Error) {
	args := []any{spaceID}
	var cteConds []string
	cteConds = append(cteConds, `a."spaceId" = $1`)
	if input.Trashed {
		cteConds = append(cteConds, `a."trashedAt" IS NOT NULL`)
	} else {
		cteConds = append(cteConds, `a."trashedAt" IS NULL`)
	}
	cteConds = append(cteConds, `a."mimeType" <> 'text/html;profile=mcp-app' AND a."mimeType" NOT LIKE '%%;profile=step-screenshot'`)

	var outerConds []string
	if !input.Trashed && !input.AllFolders {
		if folderID == nil {
			outerConds = append(outerConds, `l."folderId" IS NULL`)
		} else {
			args = append(args, *folderID)
			outerConds = append(outerConds, fmt.Sprintf(`l."folderId" = $%d`, len(args)))
		}
	}
	if input.BotID != nil && strings.TrimSpace(*input.BotID) != "" {
		args = append(args, strings.TrimSpace(*input.BotID))
		outerConds = append(outerConds, fmt.Sprintf(`l."botId" = $%d`, len(args)))
	} else if input.MadeByBots {
		outerConds = append(outerConds, `l."botId" IS NOT NULL`)
	}
	if queryStr != "" {
		args = append(args, "%"+escapeLike(queryStr)+"%")
		p := len(args)
		outerConds = append(outerConds, fmt.Sprintf(`(l.name ILIKE $%d ESCAPE '\' OR COALESCE(l.description, '') ILIKE $%d ESCAPE '\' OR COALESCE(l.slug, '') ILIKE $%d ESCAPE '\')`, p, p, p))
	}

	switch category {
	case "all":
	case "video":
		outerConds = append(outerConds, `l."mimeType" LIKE 'video/%'`)
	case "image":
		outerConds = append(outerConds, `l."mimeType" LIKE 'image/%'`)
	case "audio":
		outerConds = append(outerConds, `l."mimeType" LIKE 'audio/%'`)
	case "archive":
		args = append(args, archiveMIMETypeList)
		outerConds = append(outerConds, fmt.Sprintf(`l."mimeType" = ANY($%d)`, len(args)))
	case "code":
		args = append(args, codeMIMETypeList)
		outerConds = append(outerConds, fmt.Sprintf(`l."mimeType" = ANY($%d)`, len(args)))
	case "document":
		args = append(args, documentMIMETypeList)
		docIdx := len(args)
		args = append(args, codeMIMETypeList)
		codeIdx := len(args)
		outerConds = append(outerConds, fmt.Sprintf(`(l."mimeType" = ANY($%d) OR (l."mimeType" LIKE 'text/%%' AND NOT (l."mimeType" = ANY($%d))))`, docIdx, codeIdx))
	default:
		return nil, nil, orpc.BadRequest("Invalid file category")
	}

	op := ">"
	orderDir := "ASC"
	if sortDir == "desc" {
		op = "<"
		orderDir = "DESC"
	}

	var orderBy string
	switch sortBy {
	case "name":
		orderBy = fmt.Sprintf(`LOWER(l.name) %s, l.id %s`, orderDir, orderDir)
		if cursor.ID != "" {
			args = append(args, cursor.SortVal, cursor.ID)
			outerConds = append(outerConds, fmt.Sprintf(`(LOWER(l.name), l.id) %s ($%d, $%d)`, op, len(args)-1, len(args)))
		}
	case "size":
		orderBy = fmt.Sprintf(`l.size %s, l.id %s`, orderDir, orderDir)
		if cursor.ID != "" {
			args = append(args, cursor.SizeVal, cursor.ID)
			outerConds = append(outerConds, fmt.Sprintf(`(l.size, l.id) %s ($%d, $%d)`, op, len(args)-1, len(args)))
		}
	default: // updatedAt
		orderBy = fmt.Sprintf(`l."updatedAt" %s, l.id %s`, orderDir, orderDir)
		if cursor.ID != "" {
			t, err := time.Parse(time.RFC3339Nano, cursor.SortVal)
			if err != nil {
				return nil, nil, orpc.BadRequest("Invalid cursor timestamp")
			}
			args = append(args, t, cursor.ID)
			outerConds = append(outerConds, fmt.Sprintf(`(l."updatedAt", l.id) %s ($%d::timestamptz, $%d)`, op, len(args)-1, len(args)))
		}
	}

	outerWhere := "TRUE"
	if len(outerConds) > 0 {
		outerWhere = strings.Join(outerConds, " AND ")
	}
	args = append(args, limit+1)
	limitParam := len(args)

	sqlQuery := fmt.Sprintf(`
		WITH families AS (
			SELECT DISTINCT ON (COALESCE(a."rootArtifactId", a.id))
				a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				a."trashedAt", a."createdAt", a."updatedAt",
				COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a
			WHERE %s
			ORDER BY COALESCE(a."rootArtifactId", a.id), a.version DESC, a."createdAt" DESC
		),
		counts AS (
			SELECT COALESCE("rootArtifactId", id) AS family_id, COUNT(*)::int AS version_count
			FROM "artifacts"
			WHERE "spaceId" = $1
			GROUP BY 1
		)
		SELECT l.id, l."botId", l."groupId", l."runId", l."folderId", l.source,
			   l.name, l.slug, l.description, l."mimeType", l.size, l.hash, l.version,
			   l."trashedAt", l."createdAt", l."updatedAt",
			   c.version_count, l.updated_ts
		FROM (
			SELECT *, "updatedAt" AS updated_ts
			FROM families
		) l
		JOIN counts c ON c.family_id = l.family_id
		WHERE %s
		ORDER BY %s
		LIMIT $%d
	`, strings.Join(cteConds, " AND "), outerWhere, orderBy, limitParam)

	rows, err := tx.Query(ctx, sqlQuery, args...)
	if err != nil {
		return nil, nil, orpc.Internal()
	}
	defer rows.Close()

	type rowWithTS struct {
		file      DriveFile
		updatedTS time.Time
	}
	var items []rowWithTS
	for rows.Next() {
		var f DriveFile
		var sizeInt int
		var trashedAt *time.Time
		var createdAt, updatedAt, updatedTS time.Time
		var versionCount int
		if err := rows.Scan(
			&f.ID, &f.BotID, &f.GroupID, &f.RunID, &f.FolderID, &f.Source,
			&f.Name, &f.Slug, &f.Description, &f.MimeType, &sizeInt, &f.Hash, &f.Version,
			&trashedAt, &createdAt, &updatedAt,
			&versionCount, &updatedTS,
		); err != nil {
			return nil, nil, orpc.Internal()
		}
		f.Size = int64(sizeInt)
		f.VersionCount = versionCount
		f.TrashedAt = formatOptTime(trashedAt)
		f.CreatedAt = formatTime(createdAt)
		f.UpdatedAt = formatTime(updatedAt)
		f.ContentURL = contentURLFor(f.ID)
		items = append(items, rowWithTS{file: f, updatedTS: updatedTS})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, orpc.Internal()
	}

	var nextCursor *string
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		var c listCursor
		switch sortBy {
		case "name":
			c = listCursor{SortVal: strings.ToLower(last.file.Name), ID: last.file.ID}
		case "size":
			c = listCursor{SizeVal: last.file.Size, ID: last.file.ID}
		default:
			c = listCursor{SortVal: last.updatedTS.UTC().Format(time.RFC3339Nano), ID: last.file.ID}
		}
		encoded := encodeCursor(c)
		nextCursor = &encoded
	}

	out := make([]DriveFile, len(items))
	for i := range items {
		out[i] = items[i].file
	}
	return out, nextCursor, nil
}

// GetFile fetches a single DriveFile record.
func (s *Service) GetFile(ctx context.Context, actor db.Actor, fileID string) (DriveFile, *orpc.Error) {
	if s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}
	var out DriveFile
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				   a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				   a."trashedAt", a."createdAt", a."updatedAt",
				   COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a
			WHERE a.id = $1 AND a."spaceId" = $2
		`, fileID, actor.SpaceID)
		f, familyID, err := scanDriveFile(row)
		if err != nil {
			return err
		}
		var count int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
			actor.SpaceID, familyID).Scan(&count)
		if count > f.VersionCount {
			f.VersionCount = count
		}
		out = f
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return DriveFile{}, orpc.NotFound("File not found")
	}
	if err != nil {
		s.logger.Error("files.get failed", "error", err, "fileId", fileID)
		return DriveFile{}, orpc.Internal()
	}
	return out, nil
}

// FolderTree returns all non-trashed folders in the Space for move dialogs and trees.
func (s *Service) FolderTree(ctx context.Context, actor db.Actor) ([]DriveFolderTreeEntry, *orpc.Error) {
	if s.db == nil {
		return nil, orpc.Unavailable()
	}
	out := []DriveFolderTreeEntry{}
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, "parentId", "botId", name
			FROM "file_folders"
			WHERE "spaceId" = $1 AND "trashedAt" IS NULL
			ORDER BY LOWER(name) ASC, id ASC
		`, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var entry DriveFolderTreeEntry
			if err := rows.Scan(&entry.ID, &entry.ParentID, &entry.BotID, &entry.Name); err != nil {
				return err
			}
			out = append(out, entry)
		}
		return rows.Err()
	})
	if err != nil {
		s.logger.Error("files.folderTree failed", "error", err)
		return nil, orpc.Internal()
	}
	return out, nil
}

// Changes returns a delta feed ordered by (updatedAt ASC, id ASC) for Phase 4 sync clients.
func (s *Service) Changes(ctx context.Context, actor db.Actor, cursorRaw string, limit int) (ChangesResult, *orpc.Error) {
	if s.db == nil {
		return ChangesResult{}, orpc.Unavailable()
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}
	var cursor listCursor
	var hasCursor bool
	var cursorTS time.Time
	if cursorRaw != "" {
		var err error
		cursor, err = decodeCursor(cursorRaw)
		if err != nil {
			return ChangesResult{}, orpc.BadRequest("Invalid cursor")
		}
		cursorTS, err = time.Parse(time.RFC3339Nano, cursor.SortVal)
		if err != nil {
			return ChangesResult{}, orpc.BadRequest("Invalid cursor timestamp")
		}
		hasCursor = true
	}

	res := ChangesResult{Items: []DriveChangeItem{}}
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		args := []any{actor.SpaceID}
		cursorCond := "TRUE"
		if hasCursor {
			args = append(args, cursorTS, cursor.ID)
			cursorCond = `(u."updatedAt", u.id) > ($2::timestamptz, $3)`
		}
		args = append(args, limit+1)
		limitParam := len(args)

		rows, err := tx.Query(ctx, fmt.Sprintf(`
			WITH combined AS (
				SELECT 'folder'::text AS kind, id, "parentId", name, "trashedAt", "updatedAt",
					   NULL::text AS hash, NULL::int AS size, NULL::text AS "mimeType", NULL::int AS version
				FROM "file_folders"
				WHERE "spaceId" = $1
				UNION ALL
				SELECT DISTINCT ON (COALESCE(a."rootArtifactId", a.id))
					   'file'::text AS kind, a.id, a."folderId" AS "parentId", a.name, a."trashedAt", a."updatedAt",
					   a.hash, a.size, a."mimeType", a.version
				FROM "artifacts" a
				WHERE a."spaceId" = $1
				  AND a."mimeType" <> 'text/html;profile=mcp-app'
				  AND a."mimeType" NOT LIKE '%%;profile=step-screenshot'
				ORDER BY COALESCE(a."rootArtifactId", a.id), a.version DESC, a."createdAt" DESC
			)
			SELECT kind, id, "parentId", name, "trashedAt", "updatedAt", hash, size, "mimeType", version
			FROM combined u
			WHERE %s
			ORDER BY u."updatedAt" ASC, u.id ASC
			LIMIT $%d
		`, cursorCond, limitParam), args...)
		if err != nil {
			return err
		}
		defer rows.Close()

		type rowTS struct {
			item DriveChangeItem
			ts   time.Time
		}
		var list []rowTS
		for rows.Next() {
			var it DriveChangeItem
			var trashedAt *time.Time
			var updatedAt time.Time
			var sizeInt *int
			if err := rows.Scan(
				&it.Kind, &it.ID, &it.ParentID, &it.Name, &trashedAt, &updatedAt,
				&it.Hash, &sizeInt, &it.MimeType, &it.Version,
			); err != nil {
				return err
			}
			if sizeInt != nil {
				v := int64(*sizeInt)
				it.Size = &v
			}
			it.TrashedAt = formatOptTime(trashedAt)
			it.UpdatedAt = formatTime(updatedAt)
			list = append(list, rowTS{item: it, ts: updatedAt})
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(list) > limit {
			res.HasMore = true
			list = list[:limit]
		}
		if len(list) > 0 {
			last := list[len(list)-1]
			encoded := encodeCursor(listCursor{SortVal: last.ts.UTC().Format(time.RFC3339Nano), ID: last.item.ID})
			res.NextCursor = &encoded
		}
		res.Items = make([]DriveChangeItem, len(list))
		for i := range list {
			res.Items[i] = list[i].item
		}
		return nil
	})
	if err != nil {
		s.logger.Error("files.changes failed", "error", err)
		return ChangesResult{}, orpc.Internal()
	}
	return res, nil
}

// CreateFolder creates a folder in the Space (up to maxFolderDepth levels).
func (s *Service) CreateFolder(ctx context.Context, actor db.Actor, parentID *string, rawName string) (FileFolder, *orpc.Error) {
	if s.db == nil {
		return FileFolder{}, orpc.Unavailable()
	}
	name, err := filepolicy.ValidateDriveName(rawName)
	if err != nil {
		return FileFolder{}, orpc.BadRequest(err.Error())
	}
	pID := trimOpt(parentID)

	var out FileFolder
	var logicErr *orpc.Error
	err = s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if pID != nil {
			crumbs, fErr := s.loadBreadcrumbsTx(ctx, tx, actor.SpaceID, *pID)
			if fErr != nil {
				logicErr = fErr
				return nil
			}
			if len(crumbs) >= maxFolderDepth {
				logicErr = orpc.BadRequest("Folder nesting limit reached")
				return nil
			}
		}
		newID := effects.NewID()
		var trashedAt *time.Time
		var createdAt, updatedAt time.Time
		err := tx.QueryRow(ctx, `
			INSERT INTO "file_folders" (id, "spaceId", "parentId", "createdByUserId", name, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			RETURNING "trashedAt", "createdAt", "updatedAt"
		`, db.Data(newID, actor.SpaceID, pID, actor.UserID, name)...).Scan(&trashedAt, &createdAt, &updatedAt)
		if err != nil {
			if pgErr := mapPgErr(err, "A folder with that name already exists here"); pgErr != nil {
				logicErr = pgErr
				return nil
			}
			return err
		}
		out = FileFolder{
			ID:        newID,
			ParentID:  pID,
			Name:      name,
			TrashedAt: formatOptTime(trashedAt),
			CreatedAt: formatTime(createdAt),
			UpdatedAt: formatTime(updatedAt),
		}
		return nil
	})
	if err != nil {
		s.logger.Error("files.createFolder failed", "error", err)
		return FileFolder{}, orpc.Internal()
	}
	if logicErr != nil {
		return FileFolder{}, logicErr
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// RenameFolder renames a folder within the Space.
func (s *Service) RenameFolder(ctx context.Context, actor db.Actor, folderID, rawName string) (FileFolder, *orpc.Error) {
	if s.db == nil {
		return FileFolder{}, orpc.Unavailable()
	}
	name, err := filepolicy.ValidateDriveName(rawName)
	if err != nil {
		return FileFolder{}, orpc.BadRequest(err.Error())
	}
	var out FileFolder
	var logicErr *orpc.Error
	err = s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var trashedAt *time.Time
		var createdAt, updatedAt time.Time
		err := tx.QueryRow(ctx, `
			UPDATE "file_folders"
			SET name = $3, "updatedAt" = NOW()
			WHERE id = $1 AND "spaceId" = $2 AND "trashedAt" IS NULL
			RETURNING id, "parentId", "botId", name, "trashedAt", "createdAt", "updatedAt"
		`, append([]any{folderID, actor.SpaceID}, db.Data(name)...)...).Scan(&out.ID, &out.ParentID, &out.BotID, &out.Name, &trashedAt, &createdAt, &updatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			logicErr = orpc.NotFound("Folder not found")
			return nil
		}
		if err != nil {
			if pgErr := mapPgErr(err, "A folder with that name already exists here"); pgErr != nil {
				logicErr = pgErr
				return nil
			}
			return err
		}
		out.TrashedAt = formatOptTime(trashedAt)
		out.CreatedAt = formatTime(createdAt)
		out.UpdatedAt = formatTime(updatedAt)
		return nil
	})
	if err != nil {
		s.logger.Error("files.renameFolder failed", "error", err)
		return FileFolder{}, orpc.Internal()
	}
	if logicErr != nil {
		return FileFolder{}, logicErr
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// MoveFolder moves folderID under parentID (or Space root when nil), guarding against
// cycles and excessive nesting depth.
func (s *Service) MoveFolder(ctx context.Context, actor db.Actor, folderID string, parentID *string) (FileFolder, *orpc.Error) {
	if s.db == nil {
		return FileFolder{}, orpc.Unavailable()
	}
	pID := trimOpt(parentID)
	if pID != nil && *pID == folderID {
		return FileFolder{}, orpc.BadRequest("Cannot move a folder into itself")
	}

	var out FileFolder
	var logicErr *orpc.Error
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT ("trashedAt" IS NULL) FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`,
			folderID, actor.SpaceID).Scan(&active); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				logicErr = orpc.NotFound("Folder not found")
				return nil
			}
			return err
		}
		if !active {
			logicErr = orpc.NotFound("Folder not found")
			return nil
		}

		parentDepth := 0
		if pID != nil {
			crumbs, fErr := s.loadBreadcrumbsTx(ctx, tx, actor.SpaceID, *pID)
			if fErr != nil {
				logicErr = fErr
				return nil
			}
			for _, crumb := range crumbs {
				if crumb.ID == folderID {
					logicErr = orpc.BadRequest("Cannot move a folder into one of its descendants")
					return nil
				}
			}
			parentDepth = len(crumbs)
		}

		// Ensure parentDepth + max height of folderID's subtree <= maxFolderDepth.
		var subtreeHeight int
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id, 1 AS height
				FROM "file_folders"
				WHERE id = $1 AND "spaceId" = $2
				UNION ALL
				SELECT f.id, sub.height + 1
				FROM "file_folders" f
				JOIN sub ON f."parentId" = sub.id
				WHERE f."spaceId" = $2 AND f."trashedAt" IS NULL AND sub.height < 30
			)
			SELECT COALESCE(MAX(height), 1) FROM sub
		`, folderID, actor.SpaceID).Scan(&subtreeHeight); err != nil {
			return err
		}
		if parentDepth+subtreeHeight > maxFolderDepth {
			logicErr = orpc.BadRequest("Folder nesting limit reached")
			return nil
		}

		var trashedAt *time.Time
		var createdAt, updatedAt time.Time
		err := tx.QueryRow(ctx, `
			UPDATE "file_folders"
			SET "parentId" = $3, "updatedAt" = NOW()
			WHERE id = $1 AND "spaceId" = $2
			RETURNING id, "parentId", "botId", name, "trashedAt", "createdAt", "updatedAt"
		`, append([]any{folderID, actor.SpaceID}, db.Data(pID)...)...).Scan(&out.ID, &out.ParentID, &out.BotID, &out.Name, &trashedAt, &createdAt, &updatedAt)
		if err != nil {
			if pgErr := mapPgErr(err, "A folder with that name already exists here"); pgErr != nil {
				logicErr = pgErr
				return nil
			}
			return err
		}
		out.TrashedAt = formatOptTime(trashedAt)
		out.CreatedAt = formatTime(createdAt)
		out.UpdatedAt = formatTime(updatedAt)
		return nil
	})
	if err != nil {
		s.logger.Error("files.moveFolder failed", "error", err)
		return FileFolder{}, orpc.Internal()
	}
	if logicErr != nil {
		return FileFolder{}, logicErr
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// TrashFolder soft-deletes folderID and its descendant folders and files.
func (s *Service) TrashFolder(ctx context.Context, actor db.Actor, folderID string) *orpc.Error {
	if s.db == nil {
		return orpc.Unavailable()
	}
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "file_folders" WHERE id = $1 AND "spaceId" = $2)`,
			folderID, actor.SpaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			notFound = true
			return nil
		}
		_, err := tx.Exec(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id FROM "file_folders" WHERE id = $1 AND "spaceId" = $2
				UNION ALL
				SELECT f.id FROM "file_folders" f JOIN sub ON f."parentId" = sub.id WHERE f."spaceId" = $2
			),
			upd_folders AS (
				UPDATE "file_folders"
				SET "trashedAt" = COALESCE("trashedAt", NOW()), "updatedAt" = NOW()
				WHERE "spaceId" = $2 AND id IN (SELECT id FROM sub)
			)
			UPDATE "artifacts"
			SET "trashedAt" = COALESCE("trashedAt", NOW()), "updatedAt" = NOW()
			WHERE "spaceId" = $2 AND "folderId" IN (SELECT id FROM sub)
		`, folderID, actor.SpaceID)
		return err
	})
	if err != nil {
		s.logger.Error("files.trashFolder failed", "error", err)
		return orpc.Internal()
	}
	if notFound {
		return orpc.NotFound("Folder not found")
	}
	s.publishFilesChange(actor.SpaceID)
	return nil
}

// RestoreFolder restores a trashed folder (moving to Space root if its parent is gone/trashed).
func (s *Service) RestoreFolder(ctx context.Context, actor db.Actor, folderID string) (FileFolder, *orpc.Error) {
	if s.db == nil {
		return FileFolder{}, orpc.Unavailable()
	}
	var out FileFolder
	var logicErr *orpc.Error
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var curParent *string
		var curTrashed *time.Time
		err := tx.QueryRow(ctx, `
			SELECT "parentId", "trashedAt" FROM "file_folders" WHERE id = $1 AND "spaceId" = $2
		`, folderID, actor.SpaceID).Scan(&curParent, &curTrashed)
		if errors.Is(err, pgx.ErrNoRows) {
			logicErr = orpc.NotFound("Folder not found")
			return nil
		}
		if err != nil {
			return err
		}
		nextParent := curParent
		if curParent != nil {
			var parentActive bool
			if err := tx.QueryRow(ctx, `SELECT ("trashedAt" IS NULL) FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`,
				*curParent, actor.SpaceID).Scan(&parentActive); err != nil || !parentActive {
				nextParent = nil
			}
		}

		var trashedAt *time.Time
		var createdAt, updatedAt time.Time
		err = tx.QueryRow(ctx, `
			UPDATE "file_folders"
			SET "trashedAt" = NULL, "parentId" = $3, "updatedAt" = NOW()
			WHERE id = $1 AND "spaceId" = $2
			RETURNING id, "parentId", "botId", name, "trashedAt", "createdAt", "updatedAt"
		`, append([]any{folderID, actor.SpaceID}, db.Data(nextParent)...)...).Scan(&out.ID, &out.ParentID, &out.BotID, &out.Name, &trashedAt, &createdAt, &updatedAt)
		if err != nil {
			if pgErr := mapPgErr(err, "A folder with that name already exists in the destination"); pgErr != nil {
				logicErr = pgErr
				return nil
			}
			return err
		}
		// Restore any trashed descendant folders and files under folderID.
		if _, err := tx.Exec(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id FROM "file_folders" WHERE id = $1 AND "spaceId" = $2
				UNION ALL
				SELECT f.id FROM "file_folders" f JOIN sub ON f."parentId" = sub.id WHERE f."spaceId" = $2
			),
			upd_folders AS (
				UPDATE "file_folders"
				SET "trashedAt" = NULL, "updatedAt" = NOW()
				WHERE "spaceId" = $2 AND id IN (SELECT id FROM sub) AND "trashedAt" IS NOT NULL
			)
			UPDATE "artifacts"
			SET "trashedAt" = NULL, "updatedAt" = NOW()
			WHERE "spaceId" = $2 AND "folderId" IN (SELECT id FROM sub) AND "trashedAt" IS NOT NULL
		`, folderID, actor.SpaceID); err != nil {
			return err
		}
		out.TrashedAt = formatOptTime(trashedAt)
		out.CreatedAt = formatTime(createdAt)
		out.UpdatedAt = formatTime(updatedAt)
		return nil
	})
	if err != nil {
		s.logger.Error("files.restoreFolder failed", "error", err)
		return FileFolder{}, orpc.Internal()
	}
	if logicErr != nil {
		return FileFolder{}, logicErr
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// DeleteFolderPermanent removes folderID, all descendant folders and files, and their stored blobs.
func (s *Service) DeleteFolderPermanent(ctx context.Context, actor db.Actor, folderID string) *orpc.Error {
	if s.db == nil || s.store == nil {
		return orpc.Unavailable()
	}
	var storageKeys []string
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "file_folders" WHERE id = $1 AND "spaceId" = $2)`,
			folderID, actor.SpaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			notFound = true
			return nil
		}
		rows, err := tx.Query(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id FROM "file_folders" WHERE id = $1 AND "spaceId" = $2
				UNION ALL
				SELECT f.id FROM "file_folders" f JOIN sub ON f."parentId" = sub.id WHERE f."spaceId" = $2
			)
			DELETE FROM "artifacts"
			WHERE "spaceId" = $2 AND "folderId" IN (SELECT id FROM sub)
			RETURNING "storageKey"
		`, folderID, actor.SpaceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return err
			}
			storageKeys = append(storageKeys, k)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		_, err = tx.Exec(ctx, `DELETE FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`, folderID, actor.SpaceID)
		return err
	})
	if err != nil {
		s.logger.Error("files.deleteFolder failed", "error", err)
		return orpc.Internal()
	}
	if notFound {
		return orpc.NotFound("Folder not found")
	}
	for _, k := range storageKeys {
		_ = s.store.Remove(context.Background(), actor.SpaceID, k)
	}
	s.publishFilesChange(actor.SpaceID)
	return nil
}

// RenameFile renames the latest version's family display name (and active versions).
func (s *Service) RenameFile(ctx context.Context, actor db.Actor, fileID, rawName string) (DriveFile, *orpc.Error) {
	if s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}
	name, err := filepolicy.ValidateDriveName(rawName)
	if err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	var out DriveFile
	var notFound bool
	err = s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var rootID *string
		if err := tx.QueryRow(ctx, `SELECT "rootArtifactId" FROM "artifacts" WHERE id = $1 AND "spaceId" = $2`,
			fileID, actor.SpaceID).Scan(&rootID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				notFound = true
				return nil
			}
			return err
		}
		familyID := fileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		if _, err := tx.Exec(ctx, `
			UPDATE "artifacts" SET name = $3, "updatedAt" = NOW()
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
		`, append([]any{actor.SpaceID, familyID}, db.Data(name)...)...); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				   a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				   a."trashedAt", a."createdAt", a."updatedAt",
				   COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a WHERE a.id = $1 AND a."spaceId" = $2
		`, fileID, actor.SpaceID)
		var fam string
		f, fam, err := scanDriveFile(row)
		if err != nil {
			return err
		}
		var count int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
			actor.SpaceID, fam).Scan(&count)
		if count > f.VersionCount {
			f.VersionCount = count
		}
		out = f
		return nil
	})
	if err != nil {
		s.logger.Error("files.rename failed", "error", err)
		return DriveFile{}, orpc.Internal()
	}
	if notFound {
		return DriveFile{}, orpc.NotFound("File not found")
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// UpdateFile updates a file family's name, description, and/or searchable slug.
func (s *Service) UpdateFile(ctx context.Context, actor db.Actor, input UpdateFileInput) (DriveFile, *orpc.Error) {
	if s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}
	var nextName *string
	if input.Name != nil {
		name, err := filepolicy.ValidateDriveName(*input.Name)
		if err != nil {
			return DriveFile{}, orpc.BadRequest(err.Error())
		}
		nextName = &name
	}
	var nextDesc *string
	if input.HasDescription && input.Description != nil {
		trimmed := strings.TrimSpace(*input.Description)
		if trimmed != "" {
			if len([]rune(trimmed)) > 280 {
				return DriveFile{}, orpc.BadRequest("Description exceeds 280 characters")
			}
			nextDesc = &trimmed
		}
	}
	var nextSlug *string
	if input.HasSlug && input.Slug != nil {
		trimmed := strings.TrimSpace(*input.Slug)
		if trimmed != "" {
			normalized, err := filepolicy.NormalizeSlug(trimmed)
			if err != nil {
				return DriveFile{}, orpc.BadRequest(err.Error())
			}
			nextSlug = &normalized
		}
	}

	var out DriveFile
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var rootID *string
		if err := tx.QueryRow(ctx, `
			SELECT "rootArtifactId" FROM "artifacts"
			WHERE id = $1 AND "spaceId" = $2 AND "trashedAt" IS NULL
		`, input.FileID, actor.SpaceID).Scan(&rootID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				notFound = true
				return nil
			}
			return err
		}
		familyID := input.FileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		setClauses := make([]string, 0, 4)
		args := []any{actor.SpaceID, familyID}
		if nextName != nil {
			args = append(args, *nextName)
			setClauses = append(setClauses, fmt.Sprintf("name = $%d", len(args)))
		}
		if input.HasDescription {
			args = append(args, nextDesc)
			setClauses = append(setClauses, fmt.Sprintf("description = $%d", len(args)))
		}
		if input.HasSlug {
			args = append(args, nextSlug)
			setClauses = append(setClauses, fmt.Sprintf("slug = $%d", len(args)))
		}
		if len(setClauses) > 0 {
			setClauses = append(setClauses, `"updatedAt" = NOW()`)
			if _, err := tx.Exec(ctx, fmt.Sprintf(`
				UPDATE "artifacts" SET %s
				WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
			`, strings.Join(setClauses, ", ")), args...); err != nil {
				return err
			}
		}

		row := tx.QueryRow(ctx, `
			SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				   a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				   a."trashedAt", a."createdAt", a."updatedAt",
				   COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a WHERE a.id = $1 AND a."spaceId" = $2
		`, input.FileID, actor.SpaceID)
		f, fam, err := scanDriveFile(row)
		if err != nil {
			return err
		}
		var count int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
			actor.SpaceID, fam).Scan(&count)
		if count > f.VersionCount {
			f.VersionCount = count
		}
		out = f
		return nil
	})
	if err != nil {
		s.logger.Error("files.update failed", "error", err)
		return DriveFile{}, orpc.Internal()
	}
	if notFound {
		return DriveFile{}, orpc.NotFound("File not found")
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// MoveFile moves a file family to folderID (or Space root when nil).
func (s *Service) MoveFile(ctx context.Context, actor db.Actor, fileID string, folderID *string) (DriveFile, *orpc.Error) {
	if s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}
	fID := trimOpt(folderID)
	var out DriveFile
	var logicErr *orpc.Error
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if fID != nil {
			var active bool
			if err := tx.QueryRow(ctx, `SELECT ("trashedAt" IS NULL) FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`,
				*fID, actor.SpaceID).Scan(&active); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					logicErr = orpc.NotFound("Destination folder not found")
					return nil
				}
				return err
			}
			if !active {
				logicErr = orpc.BadRequest("Cannot move into a trashed folder")
				return nil
			}
		}
		var rootID *string
		if err := tx.QueryRow(ctx, `SELECT "rootArtifactId" FROM "artifacts" WHERE id = $1 AND "spaceId" = $2 AND "trashedAt" IS NULL`,
			fileID, actor.SpaceID).Scan(&rootID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				logicErr = orpc.NotFound("File not found")
				return nil
			}
			return err
		}
		familyID := fileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		if _, err := tx.Exec(ctx, `
			UPDATE "artifacts" SET "folderId" = $3, "updatedAt" = NOW()
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
		`, append([]any{actor.SpaceID, familyID}, db.Data(fID)...)...); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				   a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				   a."trashedAt", a."createdAt", a."updatedAt",
				   COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a WHERE a.id = $1 AND a."spaceId" = $2
		`, fileID, actor.SpaceID)
		var fam string
		f, fam, err := scanDriveFile(row)
		if err != nil {
			return err
		}
		var count int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
			actor.SpaceID, fam).Scan(&count)
		if count > f.VersionCount {
			f.VersionCount = count
		}
		out = f
		return nil
	})
	if err != nil {
		s.logger.Error("files.move failed", "error", err)
		return DriveFile{}, orpc.Internal()
	}
	if logicErr != nil {
		return DriveFile{}, logicErr
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// TrashFile soft-deletes a file family.
func (s *Service) TrashFile(ctx context.Context, actor db.Actor, fileID string) *orpc.Error {
	if s.db == nil {
		return orpc.Unavailable()
	}
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var rootID *string
		if err := tx.QueryRow(ctx, `SELECT "rootArtifactId" FROM "artifacts" WHERE id = $1 AND "spaceId" = $2`,
			fileID, actor.SpaceID).Scan(&rootID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				notFound = true
				return nil
			}
			return err
		}
		familyID := fileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		_, err := tx.Exec(ctx, `
			UPDATE "artifacts"
			SET "trashedAt" = COALESCE("trashedAt", NOW()), "updatedAt" = NOW()
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
		`, actor.SpaceID, familyID)
		return err
	})
	if err != nil {
		s.logger.Error("files.trash failed", "error", err)
		return orpc.Internal()
	}
	if notFound {
		return orpc.NotFound("File not found")
	}
	s.publishFilesChange(actor.SpaceID)
	return nil
}

// RestoreFile restores a trashed file family (resets folderId if destination folder is missing/trashed).
func (s *Service) RestoreFile(ctx context.Context, actor db.Actor, fileID string) (DriveFile, *orpc.Error) {
	if s.db == nil {
		return DriveFile{}, orpc.Unavailable()
	}
	var out DriveFile
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var rootID, folderID *string
		if err := tx.QueryRow(ctx, `SELECT "rootArtifactId", "folderId" FROM "artifacts" WHERE id = $1 AND "spaceId" = $2`,
			fileID, actor.SpaceID).Scan(&rootID, &folderID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				notFound = true
				return nil
			}
			return err
		}
		if folderID != nil {
			var active bool
			if err := tx.QueryRow(ctx, `SELECT ("trashedAt" IS NULL) FROM "file_folders" WHERE id = $1 AND "spaceId" = $2`,
				*folderID, actor.SpaceID).Scan(&active); err != nil || !active {
				folderID = nil
			}
		}
		familyID := fileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		if _, err := tx.Exec(ctx, `
			UPDATE "artifacts"
			SET "trashedAt" = NULL, "folderId" = $3, "updatedAt" = NOW()
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
		`, append([]any{actor.SpaceID, familyID}, db.Data(folderID)...)...); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			SELECT a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
				   a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
				   a."trashedAt", a."createdAt", a."updatedAt",
				   COALESCE(a."rootArtifactId", a.id) AS family_id
			FROM "artifacts" a WHERE a.id = $1 AND a."spaceId" = $2
		`, fileID, actor.SpaceID)
		var fam string
		f, fam, err := scanDriveFile(row)
		if err != nil {
			return err
		}
		var count int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM "artifacts" WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)`,
			actor.SpaceID, fam).Scan(&count)
		if count > f.VersionCount {
			f.VersionCount = count
		}
		out = f
		return nil
	})
	if err != nil {
		s.logger.Error("files.restore failed", "error", err)
		return DriveFile{}, orpc.Internal()
	}
	if notFound {
		return DriveFile{}, orpc.NotFound("File not found")
	}
	s.publishFilesChange(actor.SpaceID)
	return out, nil
}

// DeleteFilePermanent deletes a file version family from DB and blob storage.
func (s *Service) DeleteFilePermanent(ctx context.Context, actor db.Actor, fileID string) *orpc.Error {
	if s.db == nil || s.store == nil {
		return orpc.Unavailable()
	}
	var keys []string
	var notFound bool
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var rootID *string
		if err := tx.QueryRow(ctx, `SELECT "rootArtifactId" FROM "artifacts" WHERE id = $1 AND "spaceId" = $2`,
			fileID, actor.SpaceID).Scan(&rootID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				notFound = true
				return nil
			}
			return err
		}
		familyID := fileID
		if rootID != nil && *rootID != "" {
			familyID = *rootID
		}
		rows, err := tx.Query(ctx, `
			DELETE FROM "artifacts"
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2)
			RETURNING "storageKey"
		`, actor.SpaceID, familyID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			keys = append(keys, k)
		}
		return rows.Err()
	})
	if err != nil {
		s.logger.Error("files.deletePermanent failed", "error", err)
		return orpc.Internal()
	}
	if notFound {
		return orpc.NotFound("File not found")
	}
	for _, k := range keys {
		_ = s.store.Remove(context.Background(), actor.SpaceID, k)
	}
	s.publishFilesChange(actor.SpaceID)
	return nil
}

// EmptyTrash permanently deletes all trashed artifacts and trashed folders in the Space.
func (s *Service) EmptyTrash(ctx context.Context, actor db.Actor) (int, *orpc.Error) {
	if s.db == nil || s.store == nil {
		return 0, orpc.Unavailable()
	}
	var keys []string
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			DELETE FROM "artifacts"
			WHERE "spaceId" = $1 AND "trashedAt" IS NOT NULL
			RETURNING "storageKey"
		`, actor.SpaceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return err
			}
			keys = append(keys, k)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		_, err = tx.Exec(ctx, `DELETE FROM "file_folders" WHERE "spaceId" = $1 AND "trashedAt" IS NOT NULL`, actor.SpaceID)
		return err
	})
	if err != nil {
		s.logger.Error("files.emptyTrash failed", "error", err)
		return 0, orpc.Internal()
	}
	for _, k := range keys {
		_ = s.store.Remove(context.Background(), actor.SpaceID, k)
	}
	s.publishFilesChange(actor.SpaceID)
	return len(keys), nil
}

// CreateBase64Artifact provides legacy artifacts.create oRPC parity using the broadened
// policy and Space Drive storage.
func (s *Service) CreateBase64Artifact(ctx context.Context, actor db.Actor, input LegacyArtifactCreateInput) (LegacyArtifact, *orpc.Error) {
	if strings.TrimSpace(input.ContentBase64) == "" {
		return LegacyArtifact{}, orpc.BadRequest("Missing contentBase64 file content")
	}
	maxB64 := ((s.maxLegacyBytes + 2) / 3) * 4
	if int64(len(input.ContentBase64)) > maxB64+64 {
		return LegacyArtifact{}, orpc.TooLarge("File exceeds the inline upload limit; use multipart upload")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.ContentBase64))
	if err != nil {
		return LegacyArtifact{}, orpc.BadRequest("Invalid base64 encoding")
	}
	if int64(len(raw)) > s.maxLegacyBytes {
		return LegacyArtifact{}, orpc.TooLarge("File exceeds the inline upload limit; use multipart upload")
	}
	sum := sha256.Sum256(raw)
	_ = hex.EncodeToString(sum[:])

	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = "chat"
	}
	created, failure := s.UploadStream(ctx, actor, UploadParams{
		BotID:       input.BotID,
		GroupID:     input.GroupID,
		FolderID:    input.FolderID,
		Source:      source,
		Name:        input.Name,
		Slug:        input.Slug,
		Description: input.Description,
		MimeType:    input.MimeType,
		ClientNonce: input.ClientNonce,
	}, bytes.NewReader(raw))
	if failure != nil {
		return LegacyArtifact{}, failure
	}
	return LegacyArtifact{
		ID:          created.ID,
		BotID:       created.BotID,
		GroupID:     created.GroupID,
		RunID:       created.RunID,
		Name:        created.Name,
		Description: created.Description,
		MimeType:    created.MimeType,
		Size:        created.Size,
		Version:     created.Version,
		CreatedAt:   created.CreatedAt,
	}, nil
}

// GetBase64Artifact returns base64-encoded content for legacy artifacts.get / artifacts.getById callers.
func (s *Service) GetBase64Artifact(ctx context.Context, actor db.Actor, artifactID string, _, _ *string) (LegacyArtifactContent, *orpc.Error) {
	if s.db == nil || s.store == nil {
		return LegacyArtifactContent{}, orpc.Unavailable()
	}
	var item LegacyArtifact
	var storageKey string
	var createdAt time.Time
	err := s.db.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, "botId", "groupId", "runId", name, description, "mimeType", size, version, "createdAt", "storageKey"
			FROM "artifacts"
			WHERE id = $1
			  AND "spaceId" = $2
			  AND "trashedAt" IS NULL
			  AND "mimeType" NOT LIKE '%;profile=step-screenshot'
		`, artifactID, actor.SpaceID).Scan(&item.ID, &item.BotID, &item.GroupID, &item.RunID, &item.Name, &item.Description, &item.MimeType, &item.Size, &item.Version, &createdAt, &storageKey)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return LegacyArtifactContent{}, orpc.NotFound("Artifact not found")
	}
	if err != nil {
		s.logger.Error("artifacts.get failed", "error", err)
		return LegacyArtifactContent{}, orpc.Internal()
	}
	item.CreatedAt = formatTime(createdAt)

	raw, err := filestore.ReadAll(ctx, s.store, actor.SpaceID, storageKey)
	if err != nil {
		if errors.Is(err, filestore.ErrNotFound) {
			return LegacyArtifactContent{}, orpc.NotFound("Artifact contents not found")
		}
		s.logger.Error("artifacts.get read failed", "error", err)
		return LegacyArtifactContent{}, orpc.Internal()
	}
	item.Size = int64(len(raw))
	return LegacyArtifactContent{
		LegacyArtifact: item,
		ContentBase64:  base64.StdEncoding.EncodeToString(raw),
	}, nil
}
