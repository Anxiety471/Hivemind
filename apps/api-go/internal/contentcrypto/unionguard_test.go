package contentcrypto

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestPlainKeysMatchTypeScript guards MESSAGE_BLOCK_PLAIN_KEYS and EVENT_PAYLOAD_PLAIN_KEYS
// (packages/db/src/encryption/content-encryption.ts:24-37): the scalars kept readable beside each
// sealed value because queries filter on them. SealRow writes both keys into the rows Go seals, so
// a key TS adds there and Go misses leaves a filter (`array_contains`, a jsonb `path`) blind to a
// row Go wrote — or a rewrite that drops a key TS keeps.
func TestPlainKeysMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/db/src/encryption/content-encryption.ts")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		constant string
		goKeys   []string
	}{
		{name: "messageblocks plain keys", constant: "MESSAGE_BLOCK_PLAIN_KEYS", goKeys: tsunions.Keys(messageBlockPlainKeys)},
		{name: "event payload plain keys", constant: "EVENT_PAYLOAD_PLAIN_KEYS", goKeys: tsunions.Keys(eventPayloadPlainKeys)},
	}
	for _, test := range tests {
		t.Run(test.constant, func(t *testing.T) {
			keys, err := file.Strings(test.constant)
			if err != nil {
				t.Fatal(err)
			}
			if err := tsunions.SetDiff(test.name, test.goKeys, keys); err != nil {
				t.Fatalf("%v\n(%s is packages/db/src/encryption/content-encryption.ts)", err, test.constant)
			}
		})
	}
}
