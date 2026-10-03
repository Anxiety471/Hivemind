# Artifact Library

Hivemind owns a Library of immutable artifact copies in `.hivemind/artifacts.sqlite3`, alongside the configuration's other data. Content survives moving, changing or deleting the original workspace file and restarting the server. Back up this database with the other Hivemind data (use SQLite's backup API or stop the server first).

Open **Library** in the web UI to upload files, write documents, search, preview, download, publish or delete them. Files attached to chat are automatically saved privately before sending; the message includes their Library IDs, so agents can read and reference them. Removing an attachment from the composer removes it from the message, while its saved Library copy remains available. An unsuccessful message send keeps the attachments available for retry without uploading another copy.

Agents are instructed to put generated deliverables in `artifacts/` within their effective workspace. At the end of an invocation Hivemind automatically copies new or changed files there into the Library and gives their assigned IDs back to the agent before its final answer. Unchanged files are deduplicated; changed content is a new immutable version. File artifacts declared in a task result are also collected automatically from the task attempt workspace (including its isolated worktree), even outside `artifacts/`. Ordinary source-code edits and hidden files are not deliverables and are not collected. Collection skips symlinks, files over 8 MiB, paths deeper than eight levels, and scans at most 200 entries / 32 MiB per collection; use `library.add_file` for individual files outside these bounds. Restrict output folders to deliverables intended for the shared Library.

## Agent tools

Use the existing whole-reply `hivemind-tool` fence, for example:

```hivemind-tool
{"name":"library.create","args":{"title":"Investigation report","filename":"report.md","content":"# Findings\nAll checks passed."}}
```

- `library.search(query, limit)` searches titles, filenames and descriptions; default limit 20, maximum 100.
- `library.get(id)` returns metadata and UTF-8 content up to 64 KiB. Larger/binary content is available through the operator's download or a published URL.
- `library.create(title, filename, content, description)` automatically stores a text artifact.
- `library.add_file(title, path, description)` copies an existing regular file from the agent's effective workspace. Paths outside that workspace are rejected. Group conversations use their configured shared workspace; other conversations use the persona workspace.
- `library.publish(id)` returns the real, user-accessible URL. Agents must use that exact URL in their answer; chat makes HTTP(S) URLs clickable.
- `library.unpublish(id)` revokes the published URL.

The `library.*` namespace is separate from existing coordination `artifacts.get`, which reads task evidence references.

Saving and sharing are separate. All artifacts start private. Publishing creates an independent, random 256-bit read-only capability URL, without exposing the operator token. Anyone holding that URL can open it. Revoking or deleting immediately invalidates it; publishing again after revocation generates a new URL. Published Markdown and images open as documents with the same stylesheet as the Library preview; append `?raw=1` to a published URL to fetch the stored bytes instead. Published HTML is sandboxed with scripts, network requests and forms disabled. Binary formats outside the supported raster image formats download as attachments.

Library write tools and automatic collection require `artifacts.write`; publication requires `artifacts.publish`. Existing unrestricted personas retain access. Built-in worker, implementor, integrator, writer and tester roles gain `artifacts.write`; restricted personas must explicitly receive `artifacts.publish` to share. Observers can search/read, but cannot save or publish. As with shared chat/history, the Library is shared between the operator and configured personas, not isolated per persona.

## Reachable URLs

Local `hivemind serve` uses the actual loopback listener address by default. For remote deployments or reverse proxies, configure a reachable base URL (including a proxy prefix if needed):

```toml
[server]
public_base_url = "https://hivemind.example.com"
# Keep the usual token_env and allowed_origins configuration for remote operator access.
```

Remote listeners require an operator token as before. Library API routes remain behind that authentication. Only `GET`/`HEAD /artifacts/<share-token>` bypass operator authentication; this grants access to that single published copy. Hivemind does not infer external URLs from untrusted Host headers. Configure the proxy to forward `/artifacts/` as well as API routes, stripping any configured prefix.

## HTTP API

- `GET /api/v1/library?query=report&limit=50&offset=0` — paginated metadata.
- `POST /api/v1/library` — `{title, filename, description?, room_id?, content}` or `content_base64` for binary uploads; content fields are mutually exclusive. Author is assigned as `operator`.
- `GET /api/v1/library/<id>` — metadata.
- `GET /api/v1/library/<id>/content` — authenticated immutable content.
- `POST /api/v1/library/<id>/publish` — create/retrieve share URL.
- `DELETE /api/v1/library/<id>/publish` — revoke share URL.
- `DELETE /api/v1/library/<id>` — delete stored content and revoke links.

Each artifact is limited to 8 MiB. Private previews render text escaped; published responses use `no-store`, `nosniff` and a restrictive Content Security Policy.
