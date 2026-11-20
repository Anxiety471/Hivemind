package computer

import (
	"encoding/json"
	"testing"
)

func TestParseCommandDropsWhatTheSchemaRefuses(t *testing.T) {
	complete := map[string]any{
		"executionId": "e1", "kind": "shell", "command": "ls", "cwd": "/w",
		"status": "done", "exitCode": json.Number("0"), "output": "a",
	}
	if command, ok := parseCommand(complete); !ok || command.ExecutionID != "e1" || *command.ExitCode != 0 {
		t.Fatalf("complete payload = %+v ok=%v", command, ok)
	}
	// Unknown keys are stripped, not refused.
	extra := map[string]any{"extra": 1}
	for key, value := range complete {
		extra[key] = value
	}
	if _, ok := parseCommand(extra); !ok {
		t.Fatal("an extra key must not fail the schema")
	}
	// exitCode is required but null is accepted; bytes is optional but null is refused.
	nullExit := map[string]any{}
	for key, value := range complete {
		nullExit[key] = value
	}
	nullExit["exitCode"] = nil
	if command, ok := parseCommand(nullExit); !ok || command.ExitCode != nil {
		t.Fatalf("a null exitCode is running-not-finished, not a failure: %+v ok=%v", command, ok)
	}
	for _, broken := range []map[string]any{
		{"exitCode": json.Number("1.5")},
		{"exitCode": json.Number("1e400")},
		{"exitCode": "0"},
		{"exitCode": json.Number("0"), "bytes": nil},
		{"exitCode": json.Number("0"), "bytes": json.Number("-1")},
		{"exitCode": json.Number("0"), "bytes": 2.5},
		{"kind": "rm"},
		{"status": "queued"},
		{"output": 1},
	} {
		payload := map[string]any{}
		for key, value := range complete {
			payload[key] = value
		}
		for key, value := range broken {
			payload[key] = value
		}
		if _, ok := parseCommand(payload); ok {
			t.Errorf("%v must be refused", broken)
		}
	}
	if _, ok := parseCommand(nil); ok {
		t.Fatal("a null payload is not a command")
	}
	// A jsonb column decoded by the driver hands numbers over as float64.
	float := map[string]any{}
	for key, value := range complete {
		float[key] = value
	}
	float["exitCode"] = float64(3)
	float["bytes"] = float64(7)
	if command, ok := parseCommand(float); !ok || *command.ExitCode != 3 || *command.Bytes != 7 {
		t.Fatalf("driver-decoded payload = %+v ok=%v", command, ok)
	}
}

func TestFoldCommandsKeepsOrderAndFinishedWork(t *testing.T) {
	run := func(id, status string) Command { return Command{ExecutionID: id, Status: status} }
	folded := foldCommands([]Command{
		run("a", "running"),
		run("b", "running"),
		run("a", "done"),
		run("a", "running"),
		run("b", "done"),
		run("c", "done"),
		run("c", "running"),
	})
	if len(folded) != 3 {
		t.Fatalf("folded = %+v", folded)
	}
	if folded[0].ExecutionID != "a" || folded[0].Status != "done" {
		t.Fatalf("a stayed finished: %+v", folded[0])
	}
	if folded[1].ExecutionID != "b" || folded[1].Status != "done" {
		t.Fatalf("b took its later event: %+v", folded[1])
	}
	if folded[2].ExecutionID != "c" || folded[2].Status != "done" {
		t.Fatalf("c stayed finished: %+v", folded[2])
	}
}
