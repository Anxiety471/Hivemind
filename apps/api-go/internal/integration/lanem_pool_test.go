package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/vaultstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

// TestLaneMConcurrentWritesFitTheGatewayPool is the deadlock regression: the gateway pool holds
// four connections, and a write used to announce its legacy value from inside the read
// transaction that sealed it, so every request held one connection and waited for a second.
// Six concurrent writes on the gateway's pool must all finish.
func TestLaneMConcurrentWritesFitTheGatewayPool(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	store, err := secretstore.NewStore(laneMVaultKey)
	if err != nil {
		t.Fatalf("secret store: %v", err)
	}
	// The gateway's own wiring: the publisher runs on the same four-connection pool.
	writer := secretstore.NewWriter(store, secretstore.NewNotifier(
		&secretstore.PGPublisher{DB: database}))
	deployment := shared.Deployment{Vault: &shared.SecretVault{
		Writer:      writer,
		Persistence: secretstore.NewPersistence(database, writer),
	}}

	const writers = 6
	const deadline = 90 * time.Second
	finished := make(chan error, writers)
	var start sync.WaitGroup
	for index := 0; index < writers; index++ {
		start.Add(1)
		go func(index int) {
			actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
			input := orpc.Input{Raw: json.RawMessage(fmt.Sprintf(`{
				"destination": {"name":"api-%d","origin":"https://example.test","auth":{"type":"bearer"}},
				"value": "token-%d"
			}`, index, index))}
			start.Done()
			_, failure := vaultstore.VaultPut(ctx, database, deployment, actor, input)
			if failure != nil {
				finished <- fmt.Errorf("writer %d: %s: %s", index, failure.Code, failure.Message)
				return
			}
			finished <- nil
		}(index)
	}
	start.Wait()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for done := 0; done < writers; done++ {
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-timer.C:
			t.Fatalf("%d of %d concurrent writes did not finish in %s", writers-done, writers, deadline)
		}
	}
	if rows := laneMRows(t, database, s.UserID); len(rows) != writers {
		t.Fatalf("rows = %d, want %d", len(rows), writers)
	}
}
