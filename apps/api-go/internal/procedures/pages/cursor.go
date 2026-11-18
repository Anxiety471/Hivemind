package pages

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// cursor is the position after which a page of results continues.
type cursor struct {
	PinnedAt  *time.Time
	UpdatedAt time.Time
	ID        string
}

const isoMillis = "2006-01-02T15:04:05.000Z"

// encodeCursor is base64url(JSON.stringify({pinnedAt, updatedAt, id})) without padding.
func encodeCursor(pinnedAt *time.Time, updatedAt time.Time, id string) string {
	pinned := "null"
	if pinnedAt != nil {
		pinned = strconv.Quote(pinnedAt.UTC().Format(isoMillis))
	}
	idJSON, _ := json.Marshal(id)
	body := `{"pinnedAt":` + pinned + `,"updatedAt":"` + updatedAt.UTC().Format(isoMillis) + `","id":` + string(idJSON) + `}`
	return base64.RawURLEncoding.EncodeToString([]byte(body))
}

// decodeCursor is decodeCursor in pages.ts. ok is false where it throws
// PageListCursorError.
func decodeCursor(value string) (cursor, bool) {
	// A map, not a struct: JSON.parse matches keys exactly, encoding/json ignores case.
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(shared.UTF8(shared.Base64URL(value))), &parsed); err != nil {
		return cursor{}, false
	}
	var id string
	if raw := parsed["id"]; len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &id) != nil {
		return cursor{}, false
	}
	var updatedText string
	if err := json.Unmarshal(parsed["updatedAt"], &updatedText); err != nil {
		return cursor{}, false
	}
	updated, ok := shared.ParseDate(updatedText)
	if !ok {
		return cursor{}, false
	}
	result := cursor{UpdatedAt: updated, ID: id}
	if string(parsed["pinnedAt"]) != "null" {
		var pinnedText string
		if err := json.Unmarshal(parsed["pinnedAt"], &pinnedText); err != nil {
			return cursor{}, false
		}
		pinned, ok := shared.ParseDate(pinnedText)
		if !ok {
			return cursor{}, false
		}
		result.PinnedAt = &pinned
	}
	return result, true
}
