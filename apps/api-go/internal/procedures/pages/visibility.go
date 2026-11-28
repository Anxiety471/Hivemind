package pages

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

const pageShareSecretKind = "page_share"

var (
	errShareConflict = errors.New("page share changed at the same time")
	nonSlug          = regexp.MustCompile(`[^a-z0-9]+`)
)

// VisibilityResult is pages.setVisibility's output.
type VisibilityResult struct {
	Visibility string  `json:"visibility"`
	ShareURL   *string `json:"shareUrl"`
}

type pageShareRow struct {
	title      string
	visibility string
	secretID   string
}

type pageShareSecret struct {
	id         string
	ciphertext string
}

// SetVisibility implements pages.setVisibility (setPageVisibility, pages.ts:269-345).
func SetVisibility(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	pageID, visibility, failure := parseVisibility(raw)
	if failure != nil {
		return nil, failure
	}
	row, err := requirePageShare(ctx, database, actor, pageID)
	if err != nil {
		return nil, shareFailure(err)
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if visibility == "private" {
		_, replaced, err := swapPageShare(ctx, database, vault, actor, pageID, nil)
		if err != nil {
			return nil, shareFailure(err)
		}
		if replaced != nil {
			vault.Writer.Delete(ctx, replaced.ciphertext, replaced.id)
		}
		return VisibilityResult{Visibility: "private"}, nil
	}

	existing, found, loadErr := shareURLFor(ctx, database, vault, actor, row, deployment.WebOrigin)
	unreadable := ""
	if loadErr != nil {
		// The owner still gets a working link: an unreadable token is replaced.
		slog.Default().Error("page link token load", "error", loadErr)
		unreadable = row.secretID
	}
	if found {
		return VisibilityResult{Visibility: "link", ShareURL: &existing}, nil
	}

	token, err := randomShareToken()
	if err != nil {
		return nil, shared.Failure(err)
	}
	stored, err := vault.Writer.Put(ctx, token, secretstore.PutOptions{})
	if err != nil {
		return nil, shared.Failure(err)
	}
	next := &pageShareNext{
		tokenHash:  hashPageShareToken(token),
		secret:     &pageShareSecret{id: stored.ID, ciphertext: stored.Ciphertext},
		unreadable: unreadable,
	}
	kept, replaced, err := swapPageShare(ctx, database, vault, actor, pageID, next)
	if err != nil {
		vault.Writer.Delete(ctx, stored.Ciphertext, stored.ID)
		return nil, shareFailure(err)
	}
	if kept {
		// Another turn-on won while this one sealed its token: both callers get the winner's link.
		vault.Writer.Delete(ctx, stored.Ciphertext, stored.ID)
		winner, err := requirePageShare(ctx, database, actor, pageID)
		if err != nil {
			return nil, shareFailure(err)
		}
		link, found, err := shareURLFor(ctx, database, vault, actor, winner, deployment.WebOrigin)
		if err != nil {
			return nil, shared.Failure(err)
		}
		if found {
			return VisibilityResult{Visibility: "link", ShareURL: &link}, nil
		}
		return nil, orpc.Conflict("The page's sharing changed at the same time; try again")
	}
	if replaced != nil {
		vault.Writer.Delete(ctx, replaced.ciphertext, replaced.id)
	}
	link, err := pageShareURL(deployment.WebOrigin, row.title, token)
	if err != nil {
		return nil, shared.Failure(err)
	}
	return VisibilityResult{Visibility: "link", ShareURL: &link}, nil
}

func shareFailure(err error) *orpc.Error {
	if errors.Is(err, errShareConflict) {
		return orpc.Conflict("The page's sharing changed at the same time; try again")
	}
	return shared.Failure(err)
}

func parseVisibility(raw orpc.Input) (string, string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", "", validate.Fail(issues)
	}
	pageID, problems := validate.String(validate.Path{"pageId"}, object.Field("pageId"),
		validate.StringRules{Min: 1})
	var found []validate.Issue
	if problems != nil {
		found = append(found, problems...)
	}
	visibility, problems := validate.Enum(validate.Path{"visibility"}, object.Field("visibility"),
		"private", "link")
	found = append(found, problems...)
	found = append(found, object.Unrecognized(nil, "pageId", "visibility")...)
	if found != nil {
		return "", "", validate.Fail(found)
	}
	return pageID, visibility, nil
}

func requirePageShare(ctx context.Context, database *db.DB, actor db.Actor, pageID string) (pageShareRow, error) {
	var row pageShareRow
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT title, visibility, coalesce("shareSecretId", '')
			FROM pages WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3`,
			pageID, actor.SpaceID, actor.UserID).
			Scan(&row.title, &row.visibility, &row.secretID)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		return err
	})
	return row, err
}

// shareURLFor is shareUrlFor (pages.ts:141-153): false when the page has no live link, the
// stored URL when its sealed token can be read, and an error only when reading or parsing
// the token failed (the caller replaces that link).
func shareURLFor(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	actor db.Actor,
	row pageShareRow,
	webOrigin string,
) (string, bool, error) {
	if row.visibility != "link" || row.secretID == "" {
		return "", false, nil
	}
	var ciphertext string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT ciphertext FROM secrets WHERE id = $1`, row.secretID).Scan(&ciphertext)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	token, err := vault.Writer.Load(ctx, ciphertext, row.secretID)
	if err != nil {
		return "", false, err
	}
	link, err := pageShareURL(webOrigin, row.title, token)
	if err != nil {
		return "", false, err
	}
	return link, true, nil
}

// pageShareURL is pageShareUrl (packages/contracts/src/artifacts/pages.ts:76-85).
func pageShareURL(webOrigin, title, token string) (string, error) {
	slug := strings.ToLower(norm.NFKD.String(title))
	slug = nonSlug.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 60 {
		slug = slug[:60]
	}
	slug = strings.TrimRight(slug, "-")
	path := "/p/"
	if slug != "" {
		path += slug + "-"
	}
	path += token
	u, err := whatwgurl.ParseRef(path, webOrigin)
	if err != nil {
		return "", err
	}
	return u.Href(), nil
}

func randomShareToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func hashPageShareToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

type pageShareNext struct {
	tokenHash  string
	secret     *pageShareSecret
	unreadable string
}

// swapPageShare is swapPageShare (pages.ts:233-266): compare-and-swap the page's link,
// retrying once when another writer moved it. A nil next turns the link off.
func swapPageShare(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	actor db.Actor,
	pageID string,
	next *pageShareNext,
) (bool, *pageShareSecret, error) {
	for attempt := 0; ; attempt++ {
		state := vault.Persistence.NewState()
		var kept bool
		var replaced *pageShareSecret
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var current string
			err := tx.QueryRow(ctx, `SELECT coalesce("shareSecretId", '') FROM pages WHERE id = $1`,
				pageID).Scan(&current)
			if errors.Is(err, pgx.ErrNoRows) {
				return shared.NotFound
			}
			if err != nil {
				return err
			}
			if next != nil && current != "" && current != next.unreadable {
				kept = true
				return nil
			}
			var tag pgconn.CommandTag
			if next != nil {
				// A create drops no reference, so secret-persistence does not track it; the
				// row's insert is the only record of the already-announced sealed value.
				if _, err := tx.Exec(ctx, `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
					VALUES ($1, $2, $3, $4, $5)`,
					db.Data(next.secret.id, actor.UserID, actor.SpaceID,
						pageShareSecretKind, next.secret.ciphertext)...); err != nil {
					return err
				}
				tag, err = tx.Exec(ctx, `UPDATE pages SET visibility = 'link', "shareTokenHash" = $1,
					"shareSecretId" = $2 WHERE id = $3 AND "shareSecretId" IS NOT DISTINCT FROM NULLIF($4, '')`,
					append(db.Data(next.tokenHash, next.secret.id), pageID, current)...)
			} else {
				tag, err = tx.Exec(ctx, `UPDATE pages SET visibility = 'private', "shareTokenHash" = NULL,
					"shareSecretId" = NULL WHERE id = $1 AND "shareSecretId" IS NOT DISTINCT FROM NULLIF($2, '')`,
					pageID, current)
			}
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errShareConflict
			}
			if current == "" {
				return nil
			}
			replaced, err = pageShareSecretQuery(ctx, tx, current)
			if err != nil {
				return err
			}
			if err := vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
				`SELECT id FROM secrets WHERE id = $1`, current); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `DELETE FROM secrets WHERE id = $1`, current)
			return err
		})
		vault.Persistence.Finish(ctx, state, err)
		if err != nil && errors.Is(err, errShareConflict) && attempt == 0 {
			continue
		}
		return kept, replaced, err
	}
}

// pageShareSecretQuery reads the secret a CAS is about to replace; a row deleted despite the
// foreign key reads as no replacement, as Prisma's findUnique does.
func pageShareSecretQuery(ctx context.Context, tx pgx.Tx, id string) (*pageShareSecret, error) {
	var secret pageShareSecret
	err := tx.QueryRow(ctx, `SELECT id, ciphertext FROM secrets WHERE id = $1`, id).
		Scan(&secret.id, &secret.ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &secret, nil
}
