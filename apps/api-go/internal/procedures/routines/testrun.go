package routines

// routines.testRun (apps/api/src/routes/routines.ts:367): run a routine's prompt
// once as a test, on the routine's bot and thread. The target and the replay
// lookup mirror routineTestTarget/allowlookup; the task+run pair is
// createRoutineTestRun, and the run is woken after commit like every create.

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentskills"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	runslib "github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// testRunOutput is the procedure's `{ runId }` result.
type testRunOutput struct {
	RunID string `json:"runId"`
}

type testRunInput struct {
	RoutineID   string
	ClientNonce *string
}

// parseTestRun mirrors the testRun input schema: { routineId: Id; clientNonce?:
// string.min(1).max(200) }. A present null or wrong type is rejected; absent is
// not.
func parseTestRun(raw orpc.Input) (testRunInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return testRunInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	routineID, problems := validate.String(validate.Path{"routineId"}, object.Field("routineId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var nonce *string
	if value, present := object.Get("clientNonce"); present {
		text, problems := validate.String(validate.Path{"clientNonce"}, value, validate.StringRules{Min: 1, Max: 200})
		found = append(found, problems...)
		nonce = &text
	}
	if found != nil {
		return testRunInput{}, validate.Fail(found)
	}
	return testRunInput{RoutineID: routineID, ClientNonce: nonce}, nil
}

// routineTestRunNonce is routineTestRunNonce: the caller's id keeps another
// member from taking the key, and the prefix cannot collide with the previous
// release's `routine-test:<nonce>`.
func routineTestRunNonce(actor db.Actor, clientNonce string) string {
	return "routine-run:" + actor.UserID + ":" + clientNonce
}

type testTarget struct {
	RoutineID string
	BotID     string
	ThreadID  string
	Prompt    string
}

// routineTestTarget is routineTestTarget: a routine of the actor's Space on a
// bot the actor can use, with that bot's thread. Both misses are IsolationError.
func routineTestTarget(ctx context.Context, database *db.DB, actor db.Actor, routineID string) (testTarget, error) {
	var target testTarget
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, "botId", prompt FROM routines
			WHERE id = $1 AND "spaceId" = $2`, routineID, actor.SpaceID).
			Scan(&target.RoutineID, &target.BotID, &target.Prompt)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		var botID string
		var threadID *string
		err = tx.QueryRow(ctx, `SELECT b.id, t.id FROM bots b
			LEFT JOIN threads t ON t."botId" = b.id
			WHERE b.id = $1 AND b."spaceId" = $2 AND b."archivedAt" IS NULL
			LIMIT 1`, target.BotID, actor.SpaceID).Scan(&botID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && threadID == nil) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		target.BotID = botID
		target.ThreadID = *threadID
		return nil
	})
	return target, err
}

// findTestRun is findExisting: a run saved under this nonce. The pre-check also
// matches the caller (`userId`); the in-transaction re-check does not, as
// TypeScript's does not.
func findTestRun(ctx context.Context, database *db.DB, actor db.Actor, threadID, userID, nonce string) (*string, error) {
	var id string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		query := `SELECT id FROM runs WHERE "threadId" = $1 AND "clientNonce" = $2`
		arguments := []any{threadID, nonce}
		if userID != "" {
			query += ` AND "userId" = $3`
			arguments = append(arguments, userID)
		}
		query += ` LIMIT 1`
		found := tx.QueryRow(ctx, query, arguments...).Scan(&id)
		if errors.Is(found, pgx.ErrNoRows) {
			return nil
		}
		return found
	})
	if err != nil || id == "" {
		return nil, err
	}
	return &id, nil
}

// TestRun is routines.testRun. delegation and publisher are the process's
// notifier; a nil one leaves only the durable wake.
func TestRun(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseTestRun(raw)
	if failure != nil {
		return nil, failure
	}
	target, err := routineTestTarget(ctx, database, actor, input.RoutineID)
	if err != nil {
		if known := failureOf(err); known != nil {
			return nil, known
		}
		return nil, shared.Failure(err)
	}
	var nonce *string
	if input.ClientNonce != nil {
		value := routineTestRunNonce(actor, *input.ClientNonce)
		nonce = &value
	}
	if nonce != nil {
		existing, err := findTestRun(ctx, database, actor, target.ThreadID, actor.UserID, *nonce)
		if err != nil {
			return nil, shared.Failure(err)
		}
		if existing != nil {
			return testRunOutput{RunID: *existing}, nil
		}
	}
	// Fire-time expansion happens before the transaction, as in the handler: the
	// catalog read is its own tenant read.
	skills, failure := agentskills.ListWithContent(ctx, database, actor)
	if failure != nil {
		return nil, failure
	}
	prompt := expandSkillReferencesInPrompt(target.Prompt, skills)
	var runID string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if nonce != nil {
			var found string
			e := tx.QueryRow(ctx, `SELECT id FROM runs WHERE "threadId" = $1 AND "clientNonce" = $2 LIMIT 1`,
				target.ThreadID, *nonce).Scan(&found)
			if e == nil {
				runID = found
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		// createRoutineTestRun re-reads the routine's model inside the transaction:
		// the pin follows the routine as it is now, not as the target read it.
		var provider, model, thinking *string
		e := tx.QueryRow(ctx, `SELECT "modelProvider", "modelId", "thinkingLevel"
			FROM routines WHERE id = $1`, target.RoutineID).Scan(&provider, &model, &thinking)
		if errors.Is(e, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if e != nil {
			return e
		}
		created, e := runslib.Create(ctx, tx, runslib.CreateInput{
			SpaceID:     actor.SpaceID,
			BotID:       target.BotID,
			ThreadID:    target.ThreadID,
			UserID:      actor.UserID,
			Prompt:      prompt,
			Trigger:     "routine",
			RoutineID:   &target.RoutineID,
			Model:       runslib.RoutinePin(provider, model, thinking),
			ClientNonce: nonce,
		})
		if e != nil {
			return e
		}
		runID = created.RunID
		return nil
	})
	if err != nil {
		// The duplicate the unique (spaceId, clientNonce) key raises is the same
		// submission: answer it with the saved run. Any other failure is reported.
		if nonce != nil {
			existing, findErr := findTestRun(ctx, database, actor, target.ThreadID, actor.UserID, *nonce)
			if findErr != nil {
				return nil, shared.Failure(findErr)
			}
			if existing != nil {
				return testRunOutput{RunID: *existing}, nil
			}
		}
		if known := failureOf(err); known != nil {
			return nil, known
		}
		return nil, shared.Failure(err)
	}
	var publisher runslib.Publisher
	if deployment.Signals != nil {
		publisher = deployment.Signals
	}
	runslib.TryWakeFor(ctx, database, actor, publisher, nil, runID, runslib.WakeOptions{})
	return testRunOutput{RunID: runID}, nil
}

// failureOf unwraps an *orpc.Error a helper returned as an error.
func failureOf(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	return nil
}
