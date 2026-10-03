# Execution, progress, verification, and remote access

## Durable asynchronous turns

`POST /api/v1/turns` with `wait: false` persists the request in `.hivemind/execution.sqlite3` before returning `202`. The response contains `turn_id`, `room_id`, `status`, and `status_url`. The same `turn_id` appears in conversation events and the canonical room archive.

```json
{"target":{"type":"main"},"message":"Review the parser","wait":false,"idempotency_key":"parser-review-1"}
```

Reusing a key with the same target/message returns the original job. Reusing it for a different request returns `409`. Queued jobs survive a restart. A running job becomes `interrupted` after a restart; it never replays implicitly because tools may already have changed files. Each job records its `origin`: `user` for a request a client submitted, `host` for text Hivemind authored on an agent's behalf (a self-scheduled chat wakeup). A host-originated turn still reaches the room as a user-style message, but its text never authorizes the directives reserved for genuine user input. A recurring chat wakeup submits one turn per fire under the key `<wakeup-id>:<fires>`, so each fire is its own turn while a replay of the same fire stays deduped.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/v1/turns/{id}` | Durable job state and final reply result |
| `POST /api/v1/turns/{id}/cancel` | Cancel queued/running work; a running runtime is discarded |
| `POST /api/v1/turns/{id}/retry` | Explicitly replay an interrupted/failed request with a new turn ID |

`serve` processes async chat jobs serially. Autonomous tasks retain their separately configured concurrency. `serve` and `task run` acquire an OS worker lock per data directory; two workers cannot interrupt each other's jobs. `task run` processes autonomous tasks only. Embedders calling `api::router` must run `api::run_jobs(core)` or use synchronous turns; merely constructing a router does not start a provider or background task.

## Live progress

WebSocket `agent.progress` frames include `turn_id`, `room_id`, `agent_instance_id`, `kind`, `message_id`, and `text`. Supported kinds include assistant `text`, `tool_started`, `tool_finished`, and ACP `tool_status`. Reasoning, tool arguments/output, and provider diagnostics are excluded. ACP assistant message IDs distinguish intermediate messages from the final response.

Progress is an ephemeral notification stream. On lag/reconnect, inspect the job endpoint and canonical room history for final results. Do not concatenate tool activity into the final assistant reply or treat intermediate text as an accepted result.

## Measured usage budgets

```toml
[execution]
task_token_limit = 100000       # one autonomous root and descendants; chat uses room scope
project_token_limit = 1000000   # accumulated measured usage for the project workspace
require_usage = false          # true blocks future prompts after an unknown-usage prompt
```

Limits default to zero (disabled). Before every runtime prompt and autonomous dispatch, Hivemind checks accumulated measured usage. Parallel prompts already in flight can overshoot a limit; these are admission limits, not a provider-side output-token cap. They are persistent totals, not monthly billing estimates. A model subscription price is not inferred from tokens.

Pi/OMP billing usage comes from assistant `message_end.usage` counters: input, output, cache reads, and cache writes. A prompt with incomplete reporting remains unknown. OpenCode ACP context occupancy (`usage_update.used`) is used for rotation only and remains unknown for billing. An unknown record is `usage: null`, never zero.

`GET /api/v1/usage?scope=<root-task-id>` returns measured totals, unknown prompt count, and the latest 200 records. Without a scope it returns totals across the execution store. Task worktrees charge the original project workspace, not each temporary checkout. To change limits, update the operator configuration and restart; known usage is retained.

## Host verification

```toml
[[execution.checks]]
name = "cargo-test"
command = ["cargo", "test", "--locked"]
timeout_secs = 300

[[execution.checks]]
name = "cargo-clippy"
command = ["cargo", "clippy", "--locked", "--", "-D", "warnings"]
timeout_secs = 300
```

Commands are an operator-controlled executable/argv array, with no shell interpolation. Checks run before a non-root review agent starts, against a detached checkout of the submitted commit. Rust records command, commit SHA, exit code, duration, timeout, and bounded stdout/stderr. Required checks must all pass for that exact commit before review approval can complete the task. An agent cannot manufacture these records through result/evidence tools.

Missing commands, timeouts, and nonzero exit codes block the task. The operator can fix configuration and explicitly resume for another work/review attempt. Checks are disabled when none are configured; existing agent evidence rules still apply. Configured checks need Git deliverables; non-Git work cannot satisfy the gate.

`GET /api/v1/tasks/{id}/checks` exposes the latest 200 host check results. Check commands execute project code under the Hivemind OS account; configure only commands you intend to run.

## Interrupted-work recovery

Before removing an interrupted/failed/cancelled attempt checkout, Hivemind captures changed tracked and untracked files (or retains the current branch commit if work is already committed) in a labelled recovery commit and records a `recovery` artifact. Recovery commits never satisfy the deliverable gate. If preservation fails (for example an unresolved index conflict), the checkout is retained and the host prints a recovery error. Startup recovery follows the same rules.

Inspect `GET /api/v1/tasks/{id}` for artifacts, then:

```text
POST /api/v1/tasks/{id}/recovery
{"artifact_id":"<recovery-artifact-id>","action":"resume"}
```

- `resume`: explicitly select the recovery commit for the next work attempt and resume its blocked root task. It merges the selected recovery along with prerequisite commits. Terminal failures must use `restore`.
- `restore`: create a detached operator checkout under `.hivemind/recovered/<artifact-id>`, returning its workspace. Existing checkouts are never overwritten. Inspect the files or submit a new task there.
- `discard`: mark recovery as discarded for automatic restoration. Commits remain available for audit; this does not delete Git history.

Running attempts cannot be restored. Recovery captures code changes, not external side effects such as deployments or database mutations.

## Authenticated remote access

Loopback with no authentication remains the default. Remote bind fails unless an operator token is configured:

```toml
[server]
bind = "0.0.0.0"
token_env = "HIVEMIND_OPERATOR_TOKEN"
allowed_origins = ["https://hivemind.example.com"]
```

The configured token environment variable is removed from runtime and verification child environments. Agents still run under the same OS account; this is not a security boundary against malicious local processes.

Set the named environment variable to a random token containing at least 32 alphanumeric/hyphen/underscore characters. It is not stored in TOML. HTTP clients send `Authorization: Bearer <token>`. Authentication covers all HTTP endpoints and WebSocket upgrades. Credentialed browser requests require an exactly allowlisted origin. CORS preflight is allowed but cannot perform an operation.

Browser WebSockets use protocols `["hivemind.v1", "hivemind.auth.<token>"]`; the server selects only `hivemind.v1`, so the token is not echoed in the handshake response. Non-browser clients may use the Authorization header. Query-string tokens are rejected.

Place the service behind HTTPS/WSS for remote use. Avoid logging Authorization or Sec-WebSocket-Protocol headers in your reverse proxy. The token grants full operator access, including task submissions and configured verification commands; this is single-operator authentication, not multi-user tenancy or agent sandboxing.
