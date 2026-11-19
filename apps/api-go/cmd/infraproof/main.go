// Command infraproof is the Go side of the cross-language content-encryption
// and product-event proof. tools/infra-a-proof.mts drives it over JSON lines:
// each request line is answered by one response line. It is a test driver, not
// a service, and every key it uses is a test key from the environment.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
)

type request struct {
	ID        int              `json:"id"`
	Op        string           `json:"op"`
	Model     string           `json:"model"`
	Rows      []map[string]any `json:"rows"`
	KeyID     string           `json:"keyId"`
	KeySpace  string           `json:"keySpaceId"`
	SpaceID   string           `json:"spaceId"`
	Table     string           `json:"table"`
	Column    string           `json:"column"`
	RowID     string           `json:"rowId"`
	Owner     string           `json:"owner"`
	Value     string           `json:"value"`
	Plaintext string           `json:"plaintext"`
	Words     string           `json:"words"`
	Strings   []string         `json:"strings"`
	PlainKeys []string         `json:"plainKeys"`

	ThreadID          string         `json:"threadId"`
	BotID             string         `json:"botId"`
	Type              string         `json:"type"`
	RunID             string         `json:"runId"`
	Payload           map[string]any `json:"payload"`
	AllowCancelledRun bool           `json:"allowCancelledRun"`
	Lease             *events.Lease  `json:"lease"`
	Notify            bool           `json:"notify"`
	Count             int            `json:"count"`
	AppendInTx        bool           `json:"appendInTx"`
}

type response struct {
	ID         int              `json:"id"`
	OK         bool             `json:"ok,omitempty"`
	Rows       []map[string]any `json:"rows,omitempty"`
	Value      any              `json:"value,omitempty"`
	Plaintext  string           `json:"plaintext"`
	Ciphertext string           `json:"ciphertext"`
	Error      string           `json:"error,omitempty"`
	Tokens     []int32          `json:"tokens,omitempty"`
	Events     []eventOut       `json:"events,omitempty"`
	Event      *eventOut        `json:"event,omitempty"`
	MasterIDs  []string         `json:"masterIds,omitempty"`
	Active     string           `json:"active,omitempty"`
	Timing     map[string]any   `json:"timing,omitempty"`
}

type eventOut struct {
	ID            string         `json:"id"`
	Seq           int32          `json:"seq"`
	Type          string         `json:"type"`
	Payload       map[string]any `json:"payload"`
	RunID         *string        `json:"runId"`
	CreatedAt     string         `json:"createdAt"`
	FirstResponse bool           `json:"firstResponse"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "infraproof:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	connectionString := os.Getenv("DATABASE_URL")
	if connectionString == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	database, err := db.Open(ctx, connectionString, "rakazo-infra-proof")
	if err != nil {
		return err
	}
	defer database.Close()
	masters, err := contentcrypto.MasterKeysFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	provider, err := contentcrypto.NewLocalKeyProvider(masters)
	if err != nil {
		return err
	}
	store, err := contentcrypto.OpenPgSpaceKeyStore(ctx, database)
	if err != nil {
		return err
	}
	defer store.Close()
	ring := contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{EncryptWrites: true})
	publisher := &events.PGPublisher{Pool: database.Pool}

	masterIDs := make([]string, len(masters))
	for index, master := range masters {
		masterIDs[index] = master.ID
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<24)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var in request
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&in); err != nil {
			_ = encoder.Encode(response{ID: in.ID, Error: "bad request: " + err.Error()})
			continue
		}
		out := handle(ctx, database, ring, publisher, masters, masterIDs, in)
		out.ID = in.ID
		if err := encoder.Encode(out); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func handle(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing,
	publisher *events.PGPublisher, masters []contentcrypto.MasterKey, masterIDs []string,
	in request) response {
	switch in.Op {
	case "ping":
		return response{OK: true}
	case "master-ids":
		provider, _ := contentcrypto.NewLocalKeyProvider(masters)
		return response{MasterIDs: masterIDs, Active: provider.ActiveKeyID()}
	case "open-model":
		if err := ring.OpenRows(ctx, in.Model, in.Rows); err != nil {
			return response{Error: err.Error()}
		}
		return response{Rows: in.Rows}
	case "seal-model":
		out := make([]map[string]any, len(in.Rows))
		for index, row := range in.Rows {
			sealed, err := ring.SealRow(ctx, in.Model, row)
			if err != nil {
				return response{Error: err.Error()}
			}
			out[index] = sealed
		}
		return response{Rows: out}
	case "decrypt-text":
		key, err := ring.ByID(ctx, in.KeyID)
		if err != nil {
			return response{Error: err.Error()}
		}
		if in.KeySpace != "" {
			key.SpaceID = in.KeySpace
		}
		plaintext, err := contentcrypto.DecryptText(key, contentcrypto.Location{
			Table: in.Table, Column: in.Column, RowID: in.RowID, Owner: in.Owner,
		}, in.Value)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{Plaintext: plaintext}
	case "encrypt-text":
		key, err := keyFor(ctx, ring, in)
		if err != nil {
			return response{Error: err.Error()}
		}
		ciphertext, err := contentcrypto.EncryptText(key, contentcrypto.Location{
			Table: in.Table, Column: in.Column, RowID: in.RowID, Owner: in.Owner,
		}, in.Plaintext)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{Ciphertext: ciphertext}
	case "open-json":
		key, err := keyFor(ctx, ring, in)
		if err != nil {
			return response{Error: err.Error()}
		}
		decoder := json.NewDecoder(bytes.NewReader([]byte(in.Value)))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return response{Error: err.Error()}
		}
		opened, err := contentcrypto.OpenJSON(value, func(ciphertext string) (string, error) {
			return contentcrypto.DecryptText(key, contentcrypto.Location{
				Table: in.Table, Column: in.Column, RowID: in.RowID, Owner: in.Owner,
			}, ciphertext)
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{Value: opened}
	case "seal-json":
		key, err := keyFor(ctx, ring, in)
		if err != nil {
			return response{Error: err.Error()}
		}
		decoder := json.NewDecoder(bytes.NewReader([]byte(in.Value)))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return response{Error: err.Error()}
		}
		plainKeys := make(map[string]bool, len(in.PlainKeys))
		for _, name := range in.PlainKeys {
			plainKeys[name] = true
		}
		sealed, err := contentcrypto.SealJSON(value, plainKeys, func(plaintext string) (string, error) {
			return contentcrypto.EncryptText(key, contentcrypto.Location{
				Table: in.Table, Column: in.Column, RowID: in.RowID, Owner: in.Owner,
			}, plaintext)
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{Value: sealed}
	case "tokens":
		key, err := keyFor(ctx, ring, in)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{Tokens: contentcrypto.SearchTokens(key, in.Words, in.Strings)}
	case "append", "append-burst":
		count := 1
		if in.Op == "append-burst" {
			count = in.Count
		}
		out, err := appendMany(ctx, database, ring, publisher, in, count)
		if err != nil {
			return response{Error: err.Error()}
		}
		if count == 1 {
			return response{Event: &out[0]}
		}
		return response{Events: out}
	case "timing":
		return response{Timing: events.ReadRunTimingFields(ctx, database, in.RunID)}
	default:
		return response{Error: "unknown op " + in.Op}
	}
}

func keyFor(ctx context.Context, ring *contentcrypto.KeyRing, in request) (contentcrypto.DataKey, error) {
	if in.KeyID != "" {
		return ring.ByID(ctx, in.KeyID)
	}
	return ring.Current(ctx, in.SpaceID)
}

func appendMany(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing,
	publisher *events.PGPublisher, in request, count int) ([]eventOut, error) {
	out := make([]eventOut, count)
	errs := make([]error, count)
	var wait sync.WaitGroup
	for index := range count {
		wait.Add(1)
		go func() {
			defer wait.Done()
			input := events.Input{
				SpaceID: in.SpaceID, ThreadID: in.ThreadID, BotID: in.BotID,
				Type: in.Type, Payload: in.Payload, RunID: in.RunID,
				AllowCancelledRun: in.AllowCancelledRun, Lease: in.Lease,
			}
			var event events.Event
			err := database.System(ctx, "append a proof event", func(tx pgx.Tx) error {
				var appendErr error
				if in.AppendInTx {
					event, appendErr = events.AppendTx(ctx, tx, ring, input)
				} else {
					event, appendErr = events.Append(ctx, tx, ring, input)
				}
				return appendErr
			})
			if err != nil {
				errs[index] = err
				return
			}
			if in.Notify {
				events.NotifyCommitted(ctx, publisher, nil, database, in.ThreadID, event.Seq, "")
			}
			out[index] = eventOut{
				ID: event.ID, Seq: event.Seq, Type: event.Type, Payload: event.Payload,
				RunID: event.RunID, CreatedAt: event.CreatedAt.UTC().Format(time.RFC3339Nano),
				FirstResponse: event.FirstResponse,
			}
		}()
	}
	wait.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
