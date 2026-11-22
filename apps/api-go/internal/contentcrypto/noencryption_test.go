package contentcrypto

import (
	"context"
	"errors"
	"testing"
)

// TestNoEncryptionKeyRingPassesPlaintextAndRejectsCiphertext pins the contract
// the cancels rely on: an encryption-off deployment has a real ring (not nil),
// plaintext rows pass through, writes stay plaintext, and a ciphertext is a
// loud error rather than a silently skipped block.
func TestNoEncryptionKeyRingPassesPlaintextAndRejectsCiphertext(t *testing.T) {
	ring := NoEncryptionKeyRing()
	rows := []map[string]any{{
		"id": "m1", "threadId": "t1",
		"blocks": []any{map[string]any{"kind": "ask", "text": "Allow?"}},
	}}
	if err := ring.OpenRows(context.Background(), "Message", rows); err != nil {
		t.Fatalf("plaintext row: %v", err)
	}
	sealed, err := ring.SealRow(context.Background(), "Message", map[string]any{
		"id": "m2", "threadId": "t1",
		"blocks": []any{map[string]any{"kind": "text", "text": "hi"}},
	})
	if err != nil {
		t.Fatalf("seal row: %v", err)
	}
	blocks, ok := sealed["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("encryption-off ring rewrote blocks: %v", sealed["blocks"])
	}
	ciphertext := []map[string]any{{
		"id": "m3", "threadId": "t1",
		"blocks": []any{map[string]any{SealedField: "rkz1:kid1:abc"}},
	}}
	if err := ring.OpenRows(context.Background(), "Message", ciphertext); !errors.Is(err, ErrNoKeyStore) {
		t.Fatalf("ciphertext through the no-encryption ring = %v, want ErrNoKeyStore", err)
	}
}
