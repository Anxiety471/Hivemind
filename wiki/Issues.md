# Issue council

Configured personas discuss what the hive should do next — a feature, an improvement, or a bug fix — and file the ones worth doing. Each filing is an **issue**. Issues stay in the backlog. This council does not implement them, open a task, or edit the project.

The council is **off by default**. Existing configurations do not start discussions.

## Enable it

```toml
[issues]
enabled = true
mode = "automatic"          # or "scheduled"
interval_secs = 86400       # at least this long between councils
idle_secs = 1800            # automatic only: how long the hive must stay quiet
max_issues_per_round = 5
# members = ["Engineer", "Reviewer"]   # empty = every persona
# group = "development"                # if set, that group's members discuss
# workspace = "/path/to/project"       # mentioned in the prompt; workspaces are not moved
# prompt = """
# Decide the next bug the hive should file. Prefer something a user would notice.
# """
```

`serve` applies this. Change it in `hivemind.toml` or from the web UI (**Issues**); a saved change is written back to the config and used on the next pass, without a restart.

| Mode | When a discussion starts |
| --- | --- |
| `automatic` | The hive has had no live replies, queued chat jobs, or running coordination attempts for `idle_secs`, and at least `interval_secs` have passed since the previous council |
| `scheduled` | Every `interval_secs` while `serve` is running, even if someone is chatting |

The first council waits one full interval after you enable it (or after the previous one finishes), including across restarts. **Discuss now** in the UI, or `hivemind issue run`, starts one immediately.

`interval_secs` is 60–2592000. `idle_secs` is 60–86400. A round files at most `max_issues_per_round` issues (1–20).

Who attends is `group` when that is set, otherwise `members`, otherwise every persona. The web UI calls this **Who discusses**.

## What the agents do

`prompt` is the goal for the discussion. Omit it and Hivemind uses: discuss the next feature, improvement, or bug fix, and file the ones worth doing later. A custom prompt replaces that goal only. Each round still appends the filing rules, the open backlog, and an instruction not to implement, edit, or start a task. `prompt` is at most 8000 characters.

The discussion runs in the `issues` room, in discussion order. Hivemind gives the attendees two tools:

- `issues.list` — open issues, so they do not file the same idea twice
- `issues.propose` — `{kind, title, body, priority?}`. `kind` is `feature`, `improvement`, or `bug`

A repeated title returns the existing open issue. The prompt tells them not to implement anything. Their transcript is the `issues` room history.

A council left running by a crash is marked failed the next time `serve` or `issue run` starts. Do not run `issue run` while `serve` is already in a council; both share the same backlog.

## Using the backlog

```bash
hivemind issue list                  # open issues
hivemind issue list --status all
hivemind issue show <id>
hivemind issue dismiss <id> --reason "not now"
hivemind issue run                   # one council in the foreground
```

HTTP: `GET /api/v1/issues`, `GET /api/v1/issues/{id}`, `POST /api/v1/issues/{id}/dismiss`, `GET`/`PATCH /api/v1/issues/settings`, `GET`/`POST /api/v1/issues/rounds` (`POST` returns 202 and starts a discussion). Live events are `issue.proposed`, `issue.dismissed`, `issue.round.started`, `issue.round.completed`, and `issue.round.failed`.

The web UI lists the backlog and edits the prompt, the frequency, and who attends. It can also dismiss an issue or start a round.

## What this does not do

Filing an issue does not create a coordination task, assign an owner, or change any code. Implementing the backlog is separate work, done later.
