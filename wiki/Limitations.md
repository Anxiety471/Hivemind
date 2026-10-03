# Limitations

- Memory search is SQLite FTS5 full-text matching, not semantic/embedding search. There is no vector database.
- Final responses arrive at the end of a turn; WebSocket progress streams supported assistant text and sanitized tool activity.
- Authentication supports a single operator token; multi-user tenancy is not implemented.
- A runtime failure mid-turn is reported as an agent-attributed error and never retried.
- Autonomous coordination is off by default and runs only while `serve` or `task run` is running. Unsupported billing usage remains unknown, and there is no autonomous merge or deploy. See [Coordination](Coordination#known-limits).
- Access control does not cover scoped grants, per-role budgets, human approval gates, network or path restrictions for runtimes, or API principals. See [Access Control](Access-Control#not-covered).
- Self-scheduled wakeups fire once by default; a recurring one uses `repeat_seconds` (1s-7 days) optionally bounded by `repeat_count` (1-1000), or repeats until cancelled. An agent cannot list or cancel its own wakeups, and a wakeup is not offered in a thread. Waking on a **task/issue reaching a state** ("wake me when task X is ready") is not implemented: the only agent-authored wake is time-based, and there is no event-to-wake subscription for external systems such as CI or an issue tracker.
- No license has been chosen yet.
