// Package marketplace ports the reviewed plugin submissions an admin lists
// (marketplace.submissions). It reads the submission rows and turns each GitHub source into
// the browse URL the admin page opens; no registry or repository is fetched.
package marketplace

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Submission is the wire shape of PluginSubmissionSchema.
type Submission struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	Name        string  `json:"name"`
	Website     *string `json:"website"`
	Logo        *string `json:"logo"`
	Claim       *string `json:"claim"`
	Source      *string `json:"source"`
	Description string  `json:"description"`
	Testing     *string `json:"testing"`
	Status      string  `json:"status"`
	Reason      *string `json:"reason"`
	CreatedAt   string  `json:"createdAt"`
	ReviewedAt  *string `json:"reviewedAt"`
}

// Submissions implements marketplace.submissions: admins only, newest first for reviewed
// lists and oldest first for pending.
func Submissions(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	status, failure := parseSubmissionsInput(raw)
	if failure != nil {
		return nil, failure
	}
	admin, err := requireAdmin(ctx, database, deployment, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !admin {
		return nil, orpc.Forbidden("Admins only")
	}

	var rows []Submission
	err = database.System(ctx, "list plugin submissions", func(tx pgx.Tx) error {
		order := "DESC"
		if status == "pending" {
			order = "ASC"
		}
		result, err := tx.Query(ctx, `SELECT id, email, name, website, logo, claim, source, description,
			testing, status, reason, "createdAt", "reviewedAt"
			FROM plugin_submissions WHERE status = $1 ORDER BY "createdAt" `+order+` LIMIT 200`, status)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var item Submission
			var website, logo, claim, source, testing, reason *string
			var createdAt time.Time
			var reviewedAt *time.Time
			if err := result.Scan(&item.ID, &item.Email, &item.Name, &website, &logo, &claim, &source,
				&item.Description, &testing, &item.Status, &reason, &createdAt, &reviewedAt); err != nil {
				return err
			}
			if item.Status != "pending" && item.Status != "approved" && item.Status != "rejected" {
				return shared.OutputInvalid()
			}
			item.Website, item.Logo, item.Claim = website, logo, claim
			item.Testing, item.Reason = testing, reason
			if source != nil && *source != "" {
				browse, err := browseURL(*source)
				if err != nil {
					return orpc.Internal()
				}
				item.Source = &browse
			}
			item.CreatedAt = shared.ISO(createdAt)
			if reviewedAt != nil {
				at := shared.ISO(*reviewedAt)
				item.ReviewedAt = &at
			}
			rows = append(rows, item)
		}
		return result.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if rows == nil {
		rows = []Submission{}
	}
	return rows, nil
}

func parseSubmissionsInput(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	status := "pending"
	if _, ok := object.Get("status"); ok {
		var problems []validate.Issue
		status, problems = validate.Enum(validate.Path{"status"}, object.Field("status"),
			"pending", "approved", "rejected")
		if problems != nil {
			return "", validate.Fail(problems)
		}
	}
	return status, nil
}

func requireAdmin(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (bool, error) {
	if len(deployment.Me.AdminEmails) == 0 {
		return false, nil
	}
	var email string
	var verified bool
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT email, "emailVerified" FROM "user" WHERE id = $1`, actor.UserID).
			Scan(&email, &verified)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return shared.IsAdmin(deployment.Me.AdminEmails, email, verified), nil
}
