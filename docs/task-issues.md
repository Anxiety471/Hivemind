# Automated task issues

The **Tasks** page is an issue tracker connected to Hivemind's existing execution scheduler. Create an issue with a title/objective, description, acceptance criteria, labels, capabilities, and priority. Leave **Start automation immediately** enabled to run it, or disable it to save a paused backlog issue. **Start automation** authorizes the first execution. Coordination must be enabled and the workspace needs an eligible coordinator and workers.

The coordinator decomposes the issue, assigns owners and reviewers by capability and permission, and respects dependencies. Workers submit artifacts and verification; reviewers approve or return work with feedback. The root completes through the existing review gates. Attempts, failures, budgets, worktree isolation, input requests, cancellation, pause/resume, and live steering remain part of the task workflow.

## Issue behavior

- Every existing task and new subtask gets a stable, instance-wide issue number. Migration orders legacy tasks by creation time and ID. Internal task IDs and API links remain valid.
- Search matches objective/title, description, or an exact issue number (`#12`). Labels match exactly; state filters group completed, failed, and cancelled tasks as closed. Open includes backlog and blocked work.
- Root priority (`urgent`, `high`, `normal`, `low`) orders eligible tasks within the scheduler's review, planning, and ready-work phases. Children inherit their root's scheduling priority. Priority does not preempt active attempts or bypass dependencies, workspace locks, permissions, or budgets.
- Discussion and agent activity appear in one timeline. Comments persist with server-owned authorship and timestamps. Agent tool progress, review decisions, assignments, and attempts appear as activity events.
- Comments are passive: they do not answer a pending question, restart a failed task, or dispatch a worker. The latest three root comments and three subtask comments enter subsequent bounded capsules (400 bytes each). Use **Send answer** or **Steer** for those actions.
- The root description is mandatory execution context; subtask descriptions are also included on their own dispatch. Existing mandatory-context overflow handling blocks oversized prompts rather than silently dropping requirements. Labels are limited to 12 × 40 bytes, descriptions to 2,400 bytes, and comments to 4,000 bytes.
- Metadata edits require `expected_revision`. Description changes on nonterminal work require the root to be paused and all active attempts in its graph to finish. Labels and priorities can be edited while work runs. Completed issues can retain post-run discussion.
- An unused backlog issue starts its elapsed execution budget when first resumed. Pausing an issue after execution begins keeps the existing budget behavior.

## API

`POST /api/v1/tasks` preserves the original submission contract and adds optional `issue` and `auto_start` (defaults to `true`). Omitting issue fields gives an empty description/labels and normal priority.

```json
{
  "objective": "Fix expired-session handling",
  "acceptance": ["An expired session redirects to login"],
  "capabilities": ["backend"],
  "auto_start": false,
  "issue": {
    "description": "Preserve the existing session cookie policy.",
    "labels": ["bug", "security"],
    "priority": "high"
  }
}
```

| Endpoint | Behavior |
| --- | --- |
| `GET /api/v1/tasks?q=login&state=open&label=bug&priority=high` | Filter before keyset pagination (`after`, `limit`). Existing `root`, `owner`, `status`, and `all` filters remain available. |
| `PATCH /api/v1/tasks/{id}` | Replace issue metadata with `{ "expected_revision": 3, "issue": { ... } }`; stale writes return 409. |
| `POST /api/v1/tasks/{id}/comments` | Append `{ "body": "Keep existing routes compatible." }`; returns 201. |
| `GET /api/v1/tasks/{id}/comments?after=0&limit=200` | Read ascending comment history with `next_after`. |
| `GET /api/v1/tasks/{id}/timeline?before=123` | Read the latest 100 graph events for roots, or task events for children. Older pages use `next_before`; events are returned in ascending order. |
| `POST /api/v1/tasks/{id}/resume` | Start a backlog issue or resume existing automation. Existing retry/budget fields still apply. |

Existing authentication middleware protects these endpoints. A comment cannot choose its author or inject an agent identity. New `task.issue_updated` and `task.commented` events refresh connected clients through the existing live event stream.

This workflow runs inside Hivemind. It does not import or synchronize external GitHub issues.

## Verification

Rust coverage checks legacy migration and persistence, revision conflicts, validation, exact filters, priority claims, passive comments, pagination, capsule context, and first-start budgets. Browser tests at 1440px and 390px exercise backlog creation, metadata editing, comments, filters, starting the scheduler, worker artifacts, independent review, completion, and persistence after reload. The Pi runtime is a deterministic fixture; no paid model/provider is contacted by the tests.
