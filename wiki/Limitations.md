# Limitations

- Memory search is SQLite FTS5 full-text matching, not semantic/embedding search. There is no vector database.
- Responses are collected at the end of each turn, not streamed token by token.
- The API has no authentication and is loopback-only.
- A runtime failure mid-turn is reported as an agent-attributed error and never retried.
- Autonomous coordination is off by default and runs only while `serve` or `task run` is running. Token usage per dispatch is not measured, and there is no autonomous merge or deploy. See [Coordination](Coordination#known-limits).
- Access control does not cover scoped grants, per-role budgets, human approval gates, network or path restrictions for runtimes, or API principals. See [Access Control](Access-Control#not-covered).
- No license has been chosen yet.
