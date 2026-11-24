// Package trustedlinksites ports trustedLinkSites.list and trustedLinkSites.remove.
// trustedLinkSites.trust stays on the TypeScript API: it needs WHATWG URL parsing and
// the exact public-suffix list tldts ships, which Go cannot reproduce byte for byte.
package trustedlinksites

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

const maxSiteLength = 253

// List implements trustedLinkSites.list: the actor's own sites, sorted by the
// database collation exactly as Prisma's orderBy does. The trusted_link_sites
// policy keys on app.user_id, which the tenant transaction sets.
func List(ctx context.Context, database *db.DB, actor db.Actor) ([]string, *orpc.Error) {
	sites := []string{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT site FROM trusted_link_sites WHERE "userId" = $1 ORDER BY site ASC`, actor.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var site string
			if err := rows.Scan(&site); err != nil {
				return err
			}
			sites = append(sites, site)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, failure(err)
	}
	return sites, nil
}

// Remove implements trustedLinkSites.remove; removing an absent site succeeds.
func Remove(ctx context.Context, database *db.DB, actor db.Actor, input orpc.Input) (map[string]any, *orpc.Error) {
	site, invalid := parseRemove(input)
	if invalid != nil {
		return nil, invalid
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM trusted_link_sites WHERE "userId" = $1 AND site = $2`, actor.UserID, site)
		return err
	})
	if err != nil {
		return nil, failure(err)
	}
	return map[string]any{"ok": true}, nil
}

// parseRemove mirrors z.object({ site: z.string().min(1).max(253) }).
func parseRemove(input orpc.Input) (string, *orpc.Error) {
	if len(input.Raw) == 0 {
		return "", typeIssue("object", "undefined")
	}
	var value any
	if err := json.Unmarshal(input.Raw, &value); err != nil {
		return "", orpc.BadRequest("Malformed request.")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return "", typeIssue("object", jsType(value))
	}
	raw, present := object["site"]
	if !present {
		return "", typeIssue("string", "undefined", "site")
	}
	site, ok := raw.(string)
	if !ok {
		return "", typeIssue("string", jsType(raw), "site")
	}
	if !wtf8.ZodMinPass(site, 1) {
		return "", orpc.InvalidInput(map[string]any{
			"origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
			"path": []string{"site"}, "message": "Too small: expected string to have >=1 characters",
		})
	}
	if !wtf8.ZodMaxPass(site, maxSiteLength) {
		return "", orpc.InvalidInput(map[string]any{
			"origin": "string", "code": "too_big", "maximum": maxSiteLength, "inclusive": true,
			"path": []string{"site"}, "message": "Too big: expected string to have <=253 characters",
		})
	}
	return site, nil
}

func typeIssue(expected, received string, path ...string) *orpc.Error {
	if path == nil {
		path = []string{}
	}
	return orpc.InvalidInput(map[string]any{
		"expected": expected, "code": "invalid_type",
		"path": path, "message": "Invalid input: expected " + expected + ", received " + received,
	})
}

// jsType names a decoded JSON value the way zod's parsedType does.
func jsType(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case bool:
		return "boolean"
	default:
		return "number"
	}
}

func failure(err error) *orpc.Error {
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}
