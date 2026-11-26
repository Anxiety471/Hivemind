package threads

import (
	"fmt"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestLiveEventTypesMatchTypeScriptSnapshot guards liveEventTypes: the event types threads.get
// reads for live runs. They are the two inline `type: { in: [...] }` filters of threadSnapshot
// (apps/api/src/threads/thread-snapshot.ts), which no const names; a ProductEventType added there
// and missed here makes Go's snapshot omit a live step TypeScript shows, with no error.
func TestLiveEventTypesMatchTypeScriptSnapshot(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "apps/api/src/threads/thread-snapshot.ts")
	if err != nil {
		t.Fatal(err)
	}
	filters, err := file.TypeFilters()
	if err != nil {
		t.Fatal(err)
	}
	if len(filters) != 2 {
		t.Fatalf("thread-snapshot.ts has %d `type: { in: [...] }` filters, want the two live-event ones;"+
			" if the query was restructured, update this guard rather than trusting it", len(filters))
	}
	for index, filter := range filters {
		if err := tsunions.SetDiff(
			fmt.Sprintf("threads.liveEventTypes (thread-snapshot.ts filter %d)", index+1),
			liveEventTypes, filter,
		); err != nil {
			t.Fatalf("%v\n(threadSnapshot is apps/api/src/threads/thread-snapshot.ts)", err)
		}
	}
}

// TestMessageRolesMatchTypeScript guards messageRoles, the enum threadMessage checks a row's role
// against. It is MessageRole in packages/contracts/src/threads/message-blocks.ts:12; a role TS
// adds there and Go misses fails the whole thread read with "Output validation failed".
func TestMessageRolesMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/contracts/src/threads/message-blocks.ts")
	if err != nil {
		t.Fatal(err)
	}
	roles, err := file.Strings("MessageRole")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("threads.messageRoles", messageRoles, roles); err != nil {
		t.Fatalf("%v\n(MessageRole is packages/contracts/src/threads/message-blocks.ts)", err)
	}
}
