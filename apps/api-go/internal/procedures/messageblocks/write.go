package messageblocks

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Write stores a rewritten blocks list the way the Prisma write hook does: sealed with the
// message's Space key, with its blind-index tokens, or plaintext with those tokens dropped.
func Write(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, messageID, threadID string, blocks []any) error {
	sealed, err := ring.SealRow(ctx, "Message", map[string]any{
		"id": messageID, "threadId": threadID, "blocks": blocks,
	})
	if err != nil {
		return err
	}
	body, err := wtf8.Marshal(sealed["blocks"])
	if err != nil {
		return fmt.Errorf("store message blocks: %w", err)
	}
	if ring.EncryptWrites {
		args := append(append(db.Data(db.JSONText(string(body))), messageID), db.Data(sealed["searchTokens"])...)
		_, err = tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = $3 WHERE id = $2`, args...)
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = '{}' WHERE id = $2`,
		append(db.Data(db.JSONText(string(body))), messageID)...)
	return err
}
