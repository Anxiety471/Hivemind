# Limitations

- Memory search is SQLite FTS5 full-text matching, not semantic/embedding search. There is no vector database.
- Final responses arrive at the end of a turn; WebSocket progress streams supported assistant text and sanitized tool activity.
- Authentication supports a single operator token; multi-user tenancy is not implemented.
- A runtime failure mid-turn is reported as an agent-attributed error and never retried.
- Autonomous coordination is off by default and runs only while `serve` or `task run` is running. Unsupported billing usage remains unknown, and there is no autonomous merge or deploy. See [Coordination](Coordination#known-limits).
- The issue council files a backlog and stops there. It does not turn an issue into a task or implement it. See [Issues](Issues).
- Access control does not cover scoped grants, per-role budgets, human approval gates, network or path restrictions for runtimes, or API principals. See [Access Control](Access-Control#not-covered).
- No license has been chosen yet.
