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

// TestReplyTextKindsMatchTypeScript guards replyTexts: the kinds replyBlockText quotes, which feed
// a reply preview's text. message-quote.ts's switch is the source; image and file are not in it
// because a preview splits them into an attachment before reading a caption (message-quote.ts:219).
// A kind TS adds there and Go lacks makes Go answer an empty quote with no error.
func TestReplyTextKindsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/core/src/messages/message-quote.ts")
	if err != nil {
		t.Fatal(err)
	}
	quoted, err := file.SwitchCases("replyBlockText")
	if err != nil {
		t.Fatal(err)
	}
	attachments := map[string]bool{"image": true, "file": true}
	var expect []string
	for _, kind := range quoted {
		if !attachments[kind] {
			expect = append(expect, kind)
		}
	}
	if len(expect) == 0 {
		t.Fatal("replyBlockText's switch has no non-attachment kind")
	}
	if err := tsunions.SetDiff("threads.replyTexts", tsunions.Keys(replyTexts), expect); err != nil {
		t.Fatalf("%v\n(replyBlockText is packages/core/src/messages/message-quote.ts)", err)
	}
}

// TestRunEnumsMatchTypeScript guards the two enums threads.get validates a run's DTO against: a
// status or trigger TS adds and Go misses fails the whole read, exactly as a new block kind did.
func TestRunEnumsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	statuses, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "RunStatus")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("threads.runStatuses", runStatuses, statuses); err != nil {
		t.Fatalf("%v\n(RunStatus is packages/contracts/src/ids.ts)", err)
	}
	triggers, err := tsunions.Values(root, "packages/contracts/src/runs/runs.ts", "RUN_TRIGGERS")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("threads.runTriggers", runTriggers, triggers); err != nil {
		t.Fatalf("%v\n(RUN_TRIGGERS is packages/contracts/src/runs/runs.ts)", err)
	}
}
