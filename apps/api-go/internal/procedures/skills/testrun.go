package skills

// skills.testRun: the taught-skill editor's trial run (apps/api/src/bots/taught-skills.ts:506-542).
//
// The trial is an ordinary agent run: the skill's bot thread gets a queued task and run pair
// with trigger "skill", and the run is woken after the creating transaction commits. The task
// prompt is the caller's, even an explicit empty string, or the skill's playbook rendered as a
// safe test prompt (packages/core/src/skills/teach-playbook.ts:230-248). There is no model pin,
// routine, nonce or message link, as the TypeScript create writes none.

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// errNotRunnable is testRun's refusal of a skill that is still being taught.
var errNotRunnable = orpc.BadRequest("Skill must be saved or drafted first")

// formatSkillRunPrompt is formatSkillRunPrompt: the playbook as the prompt of one run. test adds
// the safety line a trial run carries. The sections are lines in a fixed order; the safety line
// of a real run and the Inputs line of an empty list are left out, and the rest are joined with
// newlines.
func formatSkillRunPrompt(name string, playbook Playbook, test bool) string {
	lines := []string{"Run taught skill: " + name}
	if test {
		lines = append(lines, "This is a safe test run. Do not send, spend, delete, or publish anything.")
	}
	lines = append(lines, "When to use: "+playbook.WhenToUse)
	if len(playbook.Inputs) > 0 {
		lines = append(lines, "Inputs: "+strings.Join(playbook.Inputs, "; "))
	}
	lines = append(lines, "Steps:")
	for index, step := range playbook.Steps {
		lines = append(lines, strconv.Itoa(index+1)+". "+step)
	}
	lines = append(lines,
		"How to check: "+playbook.HowToCheck,
		"Return: "+playbook.WhatToReturn,
		"Approval boundaries: "+playbook.ApprovalBoundaries,
		"Failure handling: "+playbook.FailureHandling,
	)
	return strings.Join(lines, "\n")
}

// skillTaskPrompt is testRun's
// `input.prompt ?? formatSkillRunPrompt(skill.name || skill.goal.slice(0, 80), playbook, true)`.
// A prompt the caller sent is the prompt even when it is empty: `??` only falls through when
// there is no prompt at all. The goal fallback counts UTF-16 units and turns a cut surrogate
// half into U+FFFD, as sliceUTF16 does for skills.save.
func skillTaskPrompt(skill row, prompt *string) string {
	if prompt != nil {
		return *prompt
	}
	name := skill.Name
	if name == "" {
		name = sliceUTF16(skill.Goal, 0, 80)
	}
	return formatSkillRunPrompt(name, parsePlaybook(skill.Playbook), true)
}

type testRunInput struct {
	SkillID string
	Prompt  *string
}

// parseTestRun is z.object({ skillId: Id, prompt: z.string().optional() }): the prompt is
// optional, a sent one is a string (null is refused), and an empty string is a prompt.
func parseTestRun(raw orpc.Input) (testRunInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return testRunInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	skillID, problems := validate.String(validate.Path{"skillId"}, object.Field("skillId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var prompt *string
	if value := object.Field("prompt"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"prompt"}, value, validate.StringRules{})
		found = append(found, problems...)
		if problems == nil {
			prompt = &text
		}
	}
	if found != nil {
		return testRunInput{}, validate.Fail(found)
	}
	return testRunInput{SkillID: skillID, Prompt: prompt}, nil
}

// testRunOutput is `{ runId }`.
type testRunOutput struct {
	RunID string `json:"runId"`
}

// TestRun implements skills.testRun: one trial run of a saved or drafted skill on its bot's
// thread. publisher delivers runs:ready; a nil one leaves only the durable wakeAt. A nil
// *effects.Notifier handed over as publisher is a non-nil interface, so a caller that wires
// deployment.Signals checks that field for nil first.
func TestRun(ctx context.Context, database *db.DB, deployment shared.Deployment, publisher runs.Publisher,
	actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseTestRun(raw)
	if failure != nil {
		return nil, failure
	}
	// botWithThread opens the thread's summary as Prisma's `include: { thread: true }` does, so
	// this read needs the ring the gateway builds, as skills.updateDraft's does.
	if deployment.Content == nil {
		return nil, shared.Failure(errors.New("content encryption is not configured"))
	}
	var created runs.Created
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		skill, err := getOwned(ctx, tx, actor, input.SkillID)
		if err != nil {
			return err
		}
		if skill.Status != "saved" && skill.Status != "draft" {
			return errNotRunnable
		}
		bot, err := botWithThread(ctx, tx, deployment.Content, skill.BotID)
		if err != nil {
			return err
		}
		if bot.ThreadID == nil {
			return shared.NotFound
		}
		created, err = runs.Create(ctx, tx, runs.CreateInput{
			SpaceID:  actor.SpaceID,
			BotID:    bot.BotID,
			ThreadID: *bot.ThreadID,
			UserID:   actor.UserID,
			Prompt:   skillTaskPrompt(skill, input.Prompt),
			Trigger:  "skill",
		})
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	// Woken after the creating transaction committed, never inside it, and a lost nudge does not
	// fail the request: the row is durable and recovery starts it (wakeRun's policy).
	runs.TryWakeFor(ctx, database, actor, publisher, slog.Default(), created.RunID, runs.WakeOptions{})
	return testRunOutput{RunID: created.RunID}, nil
}
