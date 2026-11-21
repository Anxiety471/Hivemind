package integration

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/boards"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
)

func jsonInput(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestBoardReadsAndRenameFollowTheTypeScriptRoutes(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	lab := shared.Deployment{BoardLab: true}

	// The board opens on first read, named after the Space.
	listed, failure := boards.List(ctx, database, lab, actor)
	all, _ := listed.([]boards.Board)
	if failure != nil || len(all) != 1 || all[0].Name != "Space one" || all[0].TicketPrefix != "TASK" || all[0].SpaceID != s.Space1 {
		t.Fatalf("boards.list = %#v, %v", listed, failure)
	}
	got, failure := boards.Get(ctx, database, lab, actor)
	if failure != nil || got.(boards.Board).ID != all[0].ID {
		t.Fatalf("boards.get = %#v, %v", got, failure)
	}

	// Another account's Space has its own board.
	other, failure := boards.Get(ctx, database, lab, db.Actor{UserID: s.UserID, SpaceID: s.Space2})
	if failure != nil || other.(boards.Board).ID == all[0].ID {
		t.Fatalf("second Space board = %#v, %v", other, failure)
	}

	// Without the lab the board does not exist for this account.
	if _, failure := boards.Get(ctx, database, shared.Deployment{}, actor); failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("lab off must be NOT_FOUND, got %v", failure)
	}

	for _, bad := range []string{`{}`, `{"name":"  "}`, `{"ticketPrefix":"9x"}`, `{"ticketPrefix":"ABCDEFGHIJKLM"}`, `{"name":7}`} {
		if _, failure := boards.Rename(ctx, database, lab, actor, jsonInput(bad)); failure == nil || failure.Code != "BAD_REQUEST" {
			t.Errorf("rename %s must be refused, got %v", bad, failure)
		}
	}

	renamed, failure := boards.Rename(ctx, database, lab, actor, jsonInput(`{"name":" Roadmap ","ticketPrefix":"eng"}`))
	if failure != nil || renamed.(boards.Board).Name != "Roadmap" || renamed.(boards.Board).TicketPrefix != "ENG" {
		t.Fatalf("rename = %#v, %v", renamed, failure)
	}

	created, failure := tickets.Create(ctx, database, lab, actor, jsonInput(`{"title":"First ticket"}`))
	if failure != nil {
		t.Fatalf("create: %v", failure)
	}
	ticket := created.(tickets.Ticket)
	if ticket.Ref != "ENG-1" {
		t.Fatalf("ref = %s", ticket.Ref)
	}

	// The prefix is frozen once a ticket exists; the name stays editable, and the same prefix
	// in another case changes nothing.
	if _, failure := boards.Rename(ctx, database, lab, actor, jsonInput(`{"ticketPrefix":"OPS"}`)); failure == nil ||
		failure.Message != "Cannot change the ticket prefix once tickets exist." {
		t.Fatalf("prefix change with tickets = %v", failure)
	}
	again, failure := boards.Rename(ctx, database, lab, actor, jsonInput(`{"name":"Plan","ticketPrefix":"eNg"}`))
	if failure != nil || again.(boards.Board).Name != "Plan" || again.(boards.Board).TicketPrefix != "ENG" {
		t.Fatalf("rename with the same prefix = %#v, %v", again, failure)
	}

	// tickets.get by id, and by ref in any case.
	for _, query := range []string{`{"id":"` + ticket.ID + `"}`, `{"ref":"eng-1"}`, `{"ref":" ENG-1 "}`} {
		found, failure := tickets.Get(ctx, database, lab, actor, jsonInput(query))
		if failure != nil || found.(tickets.Ticket).ID != ticket.ID {
			t.Fatalf("get %s = %#v, %v", query, found, failure)
		}
	}
	for query, code := range map[string]string{
		`{"id":"nope"}`:                        "NOT_FOUND",
		`{"ref":"ENG-2"}`:                      "NOT_FOUND",
		`{"ref":"TASK-1"}`:                     "BAD_REQUEST",
		`{"ref":"ENG-0"}`:                      "BAD_REQUEST",
		`{"ref":"ENG-99999999999"}`:            "BAD_REQUEST",
		`{}`:                                   "BAD_REQUEST",
		`{"id":"a","ref":"ENG-1"}`:             "BAD_REQUEST",
		`{"id":"` + ticket.ID + `","ref":" "}`: "BAD_REQUEST",
	} {
		if _, failure := tickets.Get(ctx, database, lab, actor, jsonInput(query)); failure == nil || failure.Code != code {
			t.Errorf("get %s: code = %v, want %s", query, failure, code)
		}
	}
	// A ticket in another Space is not found, however it is asked for.
	if _, failure := tickets.Get(ctx, database, lab, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, jsonInput(`{"id":"`+ticket.ID+`"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Errorf("foreign ticket: %v", failure)
	}

	// Comments come back oldest first with the author's name.
	for _, body := range []string{"first", "second"} {
		if _, failure := tickets.Comment(ctx, database, lab, actor, jsonInput(`{"ticketId":"`+ticket.ID+`","body":"`+body+`"}`)); failure != nil {
			t.Fatalf("comment: %v", failure)
		}
	}
	listedComments, failure := tickets.Comments(ctx, database, lab, actor, jsonInput(`{"ticketId":"`+ticket.ID+`"}`))
	comments, _ := listedComments.([]tickets.TicketComment)
	if failure != nil || len(comments) != 2 || comments[0].Body != "first" || comments[1].Body != "second" ||
		comments[0].AuthorName == nil || *comments[0].AuthorName != "Test User" {
		t.Fatalf("comments = %#v, %v", listedComments, failure)
	}
	if _, failure := tickets.Comments(ctx, database, lab, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, jsonInput(`{"ticketId":"`+ticket.ID+`"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Errorf("comments of a foreign ticket: %v", failure)
	}
}

func TestBlockedTicketNamesWhoItWaitsOn(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	lab := shared.Deployment{BoardLab: true}
	botID := "bot-" + s.UserID
	if err := database.System(ctx, "seed bot", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, 'Eggbot', 'blue', now(), now())`, botID, s.Space1, s.UserID)
		return err
	}); err != nil {
		t.Fatalf("seed bot: %v", err)
	}
	created, failure := tickets.Create(ctx, database, lab, actor, jsonInput(`{"title":"Ship the thing"}`))
	if failure != nil {
		t.Fatalf("create: %v", failure)
	}
	id := created.(tickets.Ticket).ID
	if _, failure := tickets.Move(ctx, database, lab, actor, jsonInput(`{"id":"`+id+`","status":"blocked"}`)); failure != nil {
		t.Fatalf("move: %v", failure)
	}
	if _, failure := tickets.Comment(ctx, database, lab, actor, jsonInput(`{"ticketId":"`+id+`","body":"Blocked until @Eggbot reviews it"}`)); failure != nil {
		t.Fatalf("comment: %v", failure)
	}
	fetched, failure := tickets.Get(ctx, database, lab, actor, jsonInput(`{"id":"`+id+`"}`))
	if failure != nil || len(fetched.(tickets.Ticket).WaitingOnBotIDs) != 1 || fetched.(tickets.Ticket).WaitingOnBotIDs[0] != botID {
		t.Fatalf("get waitingOn = %#v, %v", fetched, failure)
	}
	listed, failure := tickets.List(ctx, database, lab, actor, jsonInput(`{}`))
	rows := listed.(tickets.ListOutput).Tickets
	if failure != nil || len(rows) != 1 || len(rows[0].WaitingOnBotIDs) != 1 || rows[0].WaitingOnBotIDs[0] != botID {
		t.Fatalf("list waitingOn = %#v, %v", listed, failure)
	}
}

func TestArchivedTicketsLeaveTheListUntilReopened(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	lab := shared.Deployment{BoardLab: true}
	created, failure := tickets.Create(ctx, database, lab, actor, jsonInput(`{"title":"Finished work"}`))
	if failure != nil {
		t.Fatalf("create: %v", failure)
	}
	id := created.(tickets.Ticket).ID
	if _, failure := tickets.Move(ctx, database, lab, actor, jsonInput(`{"id":"`+id+`","status":"done"}`)); failure != nil {
		t.Fatalf("move to done: %v", failure)
	}
	titles := func(input string) int {
		listed, failure := tickets.List(ctx, database, lab, actor, jsonInput(input))
		if failure != nil {
			t.Fatalf("list %s: %v", input, failure)
		}
		return len(listed.(tickets.ListOutput).Tickets)
	}
	if titles(`{}`) != 1 || titles(`{"archived":true}`) != 0 {
		t.Fatalf("before archiving: board %d, archive %d", titles(`{}`), titles(`{"archived":true}`))
	}
	if err := database.System(ctx, "archive ticket", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE tickets SET "archivedAt" = now() WHERE id = $1`, id)
		return err
	}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if titles(`{}`) != 0 || titles(`{"archived":true}`) != 1 {
		t.Fatalf("after archiving: board %d, archive %d", titles(`{}`), titles(`{"archived":true}`))
	}
	// Moving within done and closed keeps it archived; reopening takes it back to the board.
	if _, failure := tickets.Move(ctx, database, lab, actor, jsonInput(`{"id":"`+id+`","status":"closed"}`)); failure != nil {
		t.Fatalf("move to closed: %v", failure)
	}
	if titles(`{"archived":true}`) != 1 {
		t.Fatalf("closed ticket left the archive")
	}
	if _, failure := tickets.Update(ctx, database, lab, actor, jsonInput(`{"id":"`+id+`","status":"doing"}`)); failure != nil {
		t.Fatalf("update to doing: %v", failure)
	}
	if titles(`{}`) != 1 || titles(`{"archived":true}`) != 0 {
		t.Fatalf("after reopening: board %d, archive %d", titles(`{}`), titles(`{"archived":true}`))
	}
}
