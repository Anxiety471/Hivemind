//! Hivemind-owned immutable artifact content, separate from task reference records.
use crate::{access::AccessPolicy, conversation::ToolHost, shared_workspace::SharedWorkspaces};
use anyhow::{bail, Context, Result};
use parking_lot::{Mutex, RwLock};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
const COLUMNS: &str = "id,title,filename,description,media_type,length(content),room_id,persona_id,created_at,share_token";

#[derive(Debug, Clone, Serialize)]
pub struct LibraryArtifact {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub description: String,
    pub media_type: String,
    pub size: usize,
    pub room_id: String,
    pub persona_id: String,
    pub created_at: u64,
    pub published: bool,
    pub url: Option<String>,
}

pub struct NewArtifact<'a> {
    pub title: &'a str,
    pub filename: &'a str,
    pub description: &'a str,
    pub media_type: &'a str,
    pub content: &'a [u8],
    pub room: &'a str,
    pub persona: &'a str,
}

pub struct ArtifactLibrary {
    db: Mutex<Connection>,
    base_url: RwLock<Option<String>>,
}

impl ArtifactLibrary {
    pub fn open(path: impl AsRef<Path>, base_url: Option<&str>) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS library_artifacts (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL,
            description TEXT NOT NULL, media_type TEXT NOT NULL, content BLOB NOT NULL,
            room_id TEXT NOT NULL, persona_id TEXT NOT NULL, created_at INTEGER NOT NULL,
            share_token TEXT UNIQUE);
            CREATE TABLE IF NOT EXISTS automatic_imports (source TEXT NOT NULL, artifact_id TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS remove_automatic_import AFTER DELETE ON library_artifacts BEGIN
                DELETE FROM automatic_imports WHERE artifact_id=OLD.id;
            END;",
        )?;
        let library = Self {
            db: Mutex::new(db),
            base_url: RwLock::new(None),
        };
        if let Some(url) = base_url {
            library.set_base_url(url)?;
        }
        Ok(library)
    }

    pub fn set_base_url(&self, url: &str) -> Result<()> {
        let uri: axum::http::Uri = url
            .parse()
            .context("server.public_base_url must be an HTTP(S) URL")?;
        anyhow::ensure!(
            matches!(uri.scheme_str(), Some("http" | "https"))
                && uri.authority().is_some_and(|a| !a.as_str().contains('@'))
                && uri.host().is_some_and(|h| !h.is_empty())
                && uri.query().is_none()
                && !url.contains('#'),
            "server.public_base_url must be an HTTP(S) URL without credentials, query or fragment"
        );
        *self.base_url.write() = Some(url.trim_end_matches('/').to_owned());
        Ok(())
    }

    fn row(&self, row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtifact> {
        let token: Option<String> = row.get(9)?;
        Ok(LibraryArtifact {
            id: row.get(0)?,
            title: row.get(1)?,
            filename: row.get(2)?,
            description: row.get(3)?,
            media_type: row.get(4)?,
            size: row.get(5)?,
            room_id: row.get(6)?,
            persona_id: row.get(7)?,
            created_at: row.get(8)?,
            published: token.is_some(),
            url: token.and_then(|t| {
                self.base_url
                    .read()
                    .as_ref()
                    .map(|base| format!("{base}/artifacts/{t}"))
            }),
        })
    }

    pub fn create(&self, new: NewArtifact<'_>) -> Result<LibraryArtifact> {
        anyhow::ensure!(
            !new.title.trim().is_empty()
                && new.title.chars().count() <= 200
                && !new.title.chars().any(char::is_control),
            "title must be 1-200 characters without control characters"
        );
        anyhow::ensure!(
            !new.filename.is_empty()
                && new.filename.len() <= 180
                && !matches!(new.filename, "." | "..")
                && !new.filename.contains(['/', '\\'])
                && !new.filename.chars().any(char::is_control),
            "filename must be a single file name without control characters"
        );
        anyhow::ensure!(
            new.description.chars().count() <= 2000,
            "description is limited to 2000 characters"
        );
        anyhow::ensure!(
            new.content.len() <= MAX_ARTIFACT_BYTES,
            "artifact exceeds the 8 MiB limit"
        );
        anyhow::ensure!(
            new.media_type.len() <= 100
                && new.media_type.contains('/')
                && new
                    .media_type
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/-+.".contains(&b)),
            "invalid media type"
        );
        let db = self.db.lock();
        // IDs identify private records; a different 256-bit token is allocated only on publish.
        let id: String = db.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        let at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        db.execute(
            "INSERT INTO library_artifacts VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            params![
                id,
                new.title.trim(),
                new.filename,
                new.description,
                new.media_type,
                new.content,
                new.room,
                new.persona,
                at
            ],
        )?;
        Ok(db.query_row(
            &format!("SELECT {COLUMNS} FROM library_artifacts WHERE id=?"),
            [&id],
            |r| self.row(r),
        )?)
    }

    pub fn list(&self, query: &str, limit: usize, offset: usize) -> Result<Vec<LibraryArtifact>> {
        anyhow::ensure!(
            query.len() <= 500 && (1..=100).contains(&limit) && offset <= 100_000,
            "invalid library search or pagination"
        );
        let db = self.db.lock();
        let mut statement = db.prepare(&format!("SELECT {COLUMNS} FROM library_artifacts WHERE instr(lower(title || ' ' || description || ' ' || filename), lower(?)) > 0 ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?"))?;
        let rows = statement.query_map(params![query, limit, offset], |r| self.row(r))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Option<LibraryArtifact>> {
        Ok(self
            .db
            .lock()
            .query_row(
                &format!("SELECT {COLUMNS} FROM library_artifacts WHERE id=?"),
                [id],
                |r| self.row(r),
            )
            .optional()?)
    }

    pub fn content(&self, id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT content FROM library_artifacts WHERE id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn publish(&self, id: &str) -> Result<Option<LibraryArtifact>> {
        anyhow::ensure!(
            self.base_url.read().is_some(),
            "start hivemind serve or configure server.public_base_url before publishing"
        );
        let db = self.db.lock();
        db.execute("UPDATE library_artifacts SET share_token=coalesce(share_token,lower(hex(randomblob(32)))) WHERE id=?", [id])?;
        Ok(db
            .query_row(
                &format!("SELECT {COLUMNS} FROM library_artifacts WHERE id=?"),
                [id],
                |r| self.row(r),
            )
            .optional()?)
    }

    pub fn unpublish(&self, id: &str) -> Result<bool> {
        Ok(self.db.lock().execute(
            "UPDATE library_artifacts SET share_token=NULL WHERE id=?",
            [id],
        )? != 0)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .db
            .lock()
            .execute("DELETE FROM library_artifacts WHERE id=?", [id])?
            != 0)
    }

    pub fn shared_content(&self, token: &str) -> Result<Option<(LibraryArtifact, Vec<u8>)>> {
        if !is_share_token(token) {
            return Ok(None);
        }
        let db = self.db.lock();
        Ok(db
            .query_row(
                &format!("SELECT {COLUMNS},content FROM library_artifacts WHERE share_token=?"),
                [token],
                |r| Ok((self.row(r)?, r.get(10)?)),
            )
            .optional()?)
    }
}

pub fn is_share_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn media_type(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" | "csv" | "log" | "ascii" => "text/plain",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mermaid" | "mmd" => "text/plain",
        "plantuml" | "puml" | "uml" => "text/plain",
        "drawio" | "xml" => "application/xml",
        "yaml" | "yml" => "text/plain",
        "toml" => "text/plain",
        _ => "application/octet-stream",
    }
}

pub struct ArtifactTools {
    library: Arc<ArtifactLibrary>,
    workspaces: Arc<SharedWorkspaces>,
    access: Arc<AccessPolicy>,
    capture_lock: Mutex<()>,
    coordination: Option<Arc<crate::coordination::CoordinationService>>,
}
impl ArtifactTools {
    pub fn new(
        library: Arc<ArtifactLibrary>,
        workspaces: Arc<SharedWorkspaces>,
        access: Arc<AccessPolicy>,
    ) -> Self {
        Self {
            library,
            workspaces,
            access,
            capture_lock: Mutex::new(()),
            coordination: None,
        }
    }
    pub fn with_coordination(
        mut self,
        service: Arc<crate::coordination::CoordinationService>,
    ) -> Self {
        self.coordination = Some(service);
        self
    }
    fn workspace(&self, room: &str, persona: &str) -> Result<String> {
        if crate::coordination::model::task_of_room(room).is_some() {
            if let Some(service) = &self.coordination {
                let ctx = service
                    .bind(room, persona)
                    .map_err(|e| anyhow::anyhow!("{e}"))?
                    .context("no active task attempt")?;
                return service
                    .store()
                    .read(|db| {
                        let task = db.task_or_err(&ctx.task_id)?;
                        let attempt = db.attempt(&ctx.attempt_id)?;
                        Ok(attempt.and_then(|a| a.worktree).unwrap_or(task.workspace))
                    })
                    .map_err(|e| anyhow::anyhow!("{e}"));
            }
        }
        let own = self
            .workspaces
            .persona(persona)
            .context("unknown persona workspace")?;
        Ok(room
            .strip_prefix("group-")
            .and_then(|id| self.workspaces.group(id))
            .unwrap_or(own))
    }
}
impl ToolHost for ArtifactTools {
    fn collect_artifacts(&self, room: &str, persona: &str) -> Result<Option<String>> {
        if !self.access.allows(persona, "artifacts.write") {
            return Ok(None);
        }
        let _guard = self.capture_lock.lock();
        let root = std::fs::canonicalize(self.workspace(room, persona)?)?;
        let outputs = root.join("artifacts");
        let mut paths = Vec::new();
        if outputs.is_dir() {
            paths.push(outputs);
        }
        // Task result file references are deliverables too, even outside artifacts/.
        if let Some(service) = &self.coordination {
            if let Some(ctx) = service
                .bind(room, persona)
                .map_err(|e| anyhow::anyhow!("{e}"))?
            {
                let references = service
                    .store()
                    .read(|db| {
                        Ok(db
                            .artifacts(&ctx.task_id)?
                            .into_iter()
                            .filter(|a| {
                                a.kind == "file"
                                    && a.attempt_id.as_deref() == Some(ctx.attempt_id.as_str())
                            })
                            .map(|a| a.reference)
                            .collect::<Vec<_>>())
                    })
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                paths.extend(references.into_iter().map(|reference| root.join(reference)));
            }
        }
        let mut saved = Vec::new();
        let mut skipped = Vec::new();
        let mut examined = 0;
        let mut bytes = 0;
        while let Some(path) = paths.pop() {
            examined += 1;
            if examined > 200 {
                break;
            }
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if path.strip_prefix(&root)?.components().count() > 8 {
                    continue;
                }
                let mut children: Vec<_> = std::fs::read_dir(path)?
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                    .map(|entry| entry.path())
                    .collect();
                children.sort();
                children.reverse();
                paths.extend(children);
                continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_ARTIFACT_BYTES as u64 {
                continue;
            }
            let content = match read_workspace_file(&root, &path) {
                Ok(content) => content,
                Err(_) => continue,
            };
            bytes += content.len();
            if bytes > 32 * 1024 * 1024 {
                break;
            }
            let source = path.to_string_lossy().to_string();
            let imported: bool = self.library.db.lock().query_row(
                "SELECT EXISTS(SELECT 1 FROM automatic_imports i JOIN library_artifacts a ON a.id=i.artifact_id WHERE i.source=?1 AND a.content=?2)",
                params![source, content], |row| row.get(0))?;
            if imported {
                continue;
            }
            self.access
                .authorize(persona, "artifacts.write", "library.collect", room)?;
            // One unsavable file (a non-UTF-8 or rejected name) is reported and
            // skipped; it must not hide the files saved around it.
            let created = path
                .file_name()
                .and_then(|s| s.to_str())
                .context("invalid filename")
                .and_then(|filename| {
                    self.library.create(NewArtifact {
                        title: filename,
                        filename,
                        description: "Automatically collected agent output",
                        media_type: media_type(filename),
                        content: &content,
                        room,
                        persona,
                    })
                });
            let artifact = match created {
                Ok(artifact) => artifact,
                Err(error) => {
                    let name = path.strip_prefix(&root).unwrap_or(&path);
                    skipped.push(format!("{} ({error})", name.to_string_lossy()));
                    continue;
                }
            };
            self.library.db.lock().execute(
                "INSERT INTO automatic_imports(source,artifact_id) VALUES(?1,?2)",
                params![source, artifact.id],
            )?;
            saved.push(artifact);
        }
        let skipped = if skipped.is_empty() {
            String::new()
        } else {
            format!(
                " Not saved (rename or use library.create): {}.",
                skipped.join("; ")
            )
        };
        if saved.is_empty() {
            return Ok(
                (!skipped.is_empty()).then(|| format!("No generated files were saved.{skipped}"))
            );
        }
        Ok(Some(format!("Generated files automatically saved to Hivemind Library: {}. Use library.publish(id) to give the user an accessible URL when requested; finalize your answer with these artifacts. Do not recreate unchanged files.{skipped}", serde_json::to_string(&saved)?)))
    }

    fn manifest(&self, _room: &str, persona: &str) -> Option<String> {
        self.access.grants(persona)?;
        let mut tools = "library.search(query,limit) · library.get(id)".to_owned();
        if self.access.allows(persona, "artifacts.write") {
            tools.push_str(" · library.create(title,filename,content,description) · library.add_file(title,path,description)");
        }
        if self.access.allows(persona, "artifacts.publish") {
            tools.push_str(" · library.publish(id) · library.unpublish(id)");
        }
        Some(format!("\nHivemind artifact library tools (one whole-reply ```hivemind-tool fence): {tools}. Write all generated deliverables to the artifacts/ directory within your effective workspace; Hivemind automatically saves new or changed files there before your final answer. Other workspace files are project source, not deliverables. For text or files elsewhere use library.create/add_file. Saved content belongs to Hivemind and survives workspace changes. Search/get returns artifact IDs and metadata; get includes UTF-8 text up to 64 KiB. Create/add_file saves a private, immutable copy (8 MiB maximum). File imports are limited to your effective workspace. Publishing explicitly gives anyone holding the link read-only access; publish only content intended for the user to access. Return the exact URL from library.publish in your final reply. Never invent URLs or use workspace file paths as links. Unpublish revokes the URL. IDs, room and author are assigned by Hivemind.\n"))
    }
    fn reminder(&self, _room: &str, _persona: &str) -> Option<String> {
        Some("Write generated deliverables under artifacts/ for automatic Library storage. Artifact library tools remain available; publish an artifact to obtain a real user-accessible URL.\n".into())
    }
    fn handles(&self, name: &str) -> bool {
        matches!(
            name,
            "library.search"
                | "library.get"
                | "library.create"
                | "library.add_file"
                | "library.publish"
                | "library.unpublish"
        )
    }
    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        anyhow::ensure!(self.access.grants(persona).is_some(), "unknown persona");
        let required = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .with_context(|| format!("tool argument '{key}' is required"))
        };
        let value = match name {
            "library.search" => {
                serde_json::json!({"artifacts": self.library.list(args.get("query").and_then(Value::as_str).unwrap_or(""), args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize, 0)?})
            }
            "library.get" => {
                let id = required("id")?;
                let record = self.library.get(id)?.context("artifact not found")?;
                let content = self.library.content(id)?.context("artifact not found")?;
                let text = (content.len() <= 65536)
                    .then(|| String::from_utf8(content).ok())
                    .flatten();
                serde_json::json!({"artifact": record, "content": text})
            }
            "library.create" | "library.add_file" => {
                self.access
                    .authorize(persona, "artifacts.write", name, room)?;
                let (filename, content) = if name == "library.add_file" {
                    let workspace = self.workspace(room, persona)?;
                    let root =
                        std::fs::canonicalize(&workspace).context("workspace unavailable")?;
                    let source = std::fs::canonicalize(root.join(required("path")?))
                        .context("artifact file unavailable")?;
                    anyhow::ensure!(
                        source.starts_with(&root),
                        "artifact file must be inside your workspace"
                    );
                    let content = read_workspace_file(&root, &source)?;
                    (
                        source
                            .file_name()
                            .and_then(|s| s.to_str())
                            .context("invalid filename")?
                            .to_owned(),
                        content,
                    )
                } else {
                    (
                        required("filename")?.to_owned(),
                        required("content")?.as_bytes().to_vec(),
                    )
                };
                serde_json::to_value(
                    self.library.create(NewArtifact {
                        title: required("title")?,
                        filename: &filename,
                        media_type: media_type(&filename),
                        content: &content,
                        description: args
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        room,
                        persona,
                    })?,
                )?
            }
            "library.publish" => {
                self.access
                    .authorize(persona, "artifacts.publish", name, room)?;
                serde_json::to_value(
                    self.library
                        .publish(required("id")?)?
                        .context("artifact not found")?,
                )?
            }
            "library.unpublish" => {
                self.access
                    .authorize(persona, "artifacts.publish", name, room)?;
                anyhow::ensure!(
                    self.library.unpublish(required("id")?)?,
                    "artifact not found"
                );
                serde_json::json!({"unpublished": true})
            }
            _ => bail!("unknown artifact tool"),
        };
        Ok(serde_json::to_string(&value)?)
    }
}

/// Validate the opened file too, so symlink swaps cannot bypass workspace confinement.
fn read_workspace_file(root: &Path, path: &Path) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "artifact must be a regular file"
    );
    #[cfg(target_os = "linux")]
    let resolved = {
        use std::os::fd::AsRawFd;
        std::fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))?
    };
    #[cfg(not(target_os = "linux"))]
    let resolved = std::fs::canonicalize(path)?;
    anyhow::ensure!(
        resolved.starts_with(root),
        "artifact file must be inside your workspace"
    );
    let mut content = Vec::new();
    file.take((MAX_ARTIFACT_BYTES + 1) as u64)
        .read_to_end(&mut content)?;
    anyhow::ensure!(
        content.len() <= MAX_ARTIFACT_BYTES,
        "artifact exceeds the 8 MiB limit"
    );
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::HivemindConfig, core::HivemindCore};
    use serde_json::json;

    #[test]
    fn persistence_search_publication_rotation_and_deletion() {
        let directory =
            std::env::temp_dir().join(format!("hivemind-library-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("library.sqlite3");
        let library = ArtifactLibrary::open(&database, Some("https://example.com/hive")).unwrap();
        let artifact = library
            .create(NewArtifact {
                title: "Report",
                filename: "report.html",
                description: "Quarterly results",
                media_type: "text/html",
                content: b"<h1>Report</h1>",
                room: "solo-Engineer",
                persona: "Engineer",
            })
            .unwrap();
        assert!(!artifact.published);
        assert!(artifact.url.is_none());
        assert_eq!(library.list("quarterly", 20, 0).unwrap().len(), 1);
        assert!(library.list("missing", 20, 0).unwrap().is_empty());
        let published = library.publish(&artifact.id).unwrap().unwrap();
        let url = published.url.unwrap();
        let token = url.rsplit('/').next().unwrap();
        assert_eq!(
            library.shared_content(token).unwrap().unwrap().1,
            b"<h1>Report</h1>"
        );
        assert_eq!(
            library
                .publish(&artifact.id)
                .unwrap()
                .unwrap()
                .url
                .as_deref(),
            Some(url.as_str())
        );
        drop(library);
        let library = ArtifactLibrary::open(&database, Some("https://example.com/hive")).unwrap();
        assert_eq!(
            library.get(&artifact.id).unwrap().unwrap().url.as_deref(),
            Some(url.as_str())
        );
        library.unpublish(&artifact.id).unwrap();
        assert!(library.shared_content(token).unwrap().is_none());
        let new_url = library.publish(&artifact.id).unwrap().unwrap().url.unwrap();
        assert_ne!(url, new_url);
        library.delete(&artifact.id).unwrap();
        assert!(library
            .shared_content(new_url.rsplit('/').next().unwrap())
            .unwrap()
            .is_none());
        drop(library);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn one_unsavable_output_does_not_hide_the_others() {
        let directory =
            std::env::temp_dir().join(format!("hivemind-output-skip-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("artifacts")).unwrap();
        let mut config = HivemindConfig::default_poc();
        let persona = config.agents[0].name.clone();
        for agent in &mut config.agents {
            agent.workspace = directory.display().to_string();
        }
        let core = HivemindCore::new(config, directory.join("hivemind.toml")).unwrap();
        let tools = ArtifactTools::new(
            core.artifacts().clone(),
            Arc::new(SharedWorkspaces::new(
                &directory.join("hivemind.toml"),
                &core.config(),
            )),
            Arc::new(AccessPolicy::from_config(
                &core.config(),
                Arc::new(crate::access::Audit::in_memory().unwrap()),
            )),
        );
        // Collected in name order: the over-long name sits between two good files.
        let long = format!("b{}.txt", "x".repeat(190));
        std::fs::write(directory.join("artifacts/a.txt"), "a").unwrap();
        std::fs::write(directory.join("artifacts").join(&long), "too long").unwrap();
        std::fs::write(directory.join("artifacts/c.txt"), "c").unwrap();
        let report = tools.collect_artifacts("solo", &persona).unwrap().unwrap();
        assert!(
            report.contains("a.txt") && report.contains("c.txt"),
            "{report}"
        );
        assert!(
            report.contains("Not saved") && report.contains(&long),
            "{report}"
        );
        assert_eq!(core.artifacts().list("", 20, 0).unwrap().len(), 2);
        drop(tools);
        drop(core);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generated_outputs_are_copied_versioned_and_confined() {
        let directory =
            std::env::temp_dir().join(format!("hivemind-output-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("artifacts")).unwrap();
        let mut config = HivemindConfig::default_poc();
        let persona = config.agents[0].name.clone();
        for agent in &mut config.agents {
            agent.workspace = directory.display().to_string();
        }
        let core = HivemindCore::new(config, directory.join("hivemind.toml")).unwrap();
        let tools = ArtifactTools::new(
            core.artifacts().clone(),
            Arc::new(SharedWorkspaces::new(
                &directory.join("hivemind.toml"),
                &core.config(),
            )),
            Arc::new(AccessPolicy::from_config(
                &core.config(),
                Arc::new(crate::access::Audit::in_memory().unwrap()),
            )),
        );
        std::fs::write(directory.join("artifacts/report.txt"), "first").unwrap();
        std::fs::write(directory.join("source.rs"), "project source").unwrap();
        assert!(tools.collect_artifacts("solo", &persona).unwrap().is_some());
        assert!(tools.collect_artifacts("solo", &persona).unwrap().is_none());
        let original = core.artifacts().list("", 20, 0).unwrap();
        assert_eq!(original.len(), 1);
        std::fs::write(directory.join("artifacts/report.txt"), "second").unwrap();
        assert!(tools.collect_artifacts("solo", &persona).unwrap().is_some());
        assert_eq!(core.artifacts().list("", 20, 0).unwrap().len(), 2);
        assert_eq!(
            core.artifacts().content(&original[0].id).unwrap().unwrap(),
            b"first"
        );
        assert!(tools
            .execute(
                "solo",
                &persona,
                "library.add_file",
                &json!({"title":"escape", "path":"/etc/passwd"})
            )
            .is_err());
        assert!(!tools.handles("artifacts.get")); // Preserve coordination's existing namespace.
        assert!(tools
            .execute("solo", "unknown", "library.search", &json!({}))
            .is_err());
        let mut restricted = core.config();
        restricted.agents[0].roles = vec!["observer".into()];
        let observer = ArtifactTools::new(
            core.artifacts().clone(),
            tools.workspaces.clone(),
            Arc::new(AccessPolicy::from_config(
                &restricted,
                Arc::new(crate::access::Audit::in_memory().unwrap()),
            )),
        );
        assert!(observer
            .execute("solo", &persona, "library.search", &json!({}))
            .is_ok());
        assert!(observer
            .execute(
                "solo",
                &persona,
                "library.create",
                &json!({"title":"Denied", "filename":"denied.txt", "content":"denied"})
            )
            .is_err());
        assert!(observer
            .execute(
                "solo",
                &persona,
                "library.publish",
                &json!({"id":original[0].id})
            )
            .is_err());
        assert!(observer
            .collect_artifacts("solo", &persona)
            .unwrap()
            .is_none());
        drop(observer);

        drop(tools);
        drop(core);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagram_and_markdown_media_types_and_deliverables() {
        assert_eq!(media_type("flowchart.mermaid"), "text/plain");
        assert_eq!(media_type("diagram.mmd"), "text/plain");
        assert_eq!(media_type("diagram.ascii"), "text/plain");
        assert_eq!(media_type("architecture.drawio"), "application/xml");
        assert_eq!(media_type("sequence.puml"), "text/plain");
        assert_eq!(media_type("doc.markdown"), "text/markdown");
        assert_eq!(media_type("vector.svg"), "image/svg+xml");

        let directory = std::env::temp_dir().join(format!("hivemind-diag-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("artifacts")).unwrap();
        let mut config = HivemindConfig::default_poc();
        let persona = config.agents[0].name.clone();
        for agent in &mut config.agents {
            agent.workspace = directory.display().to_string();
        }
        let core = HivemindCore::new(config, directory.join("hivemind.toml")).unwrap();
        let tools = ArtifactTools::new(
            core.artifacts().clone(),
            Arc::new(SharedWorkspaces::new(
                &directory.join("hivemind.toml"),
                &core.config(),
            )),
            Arc::new(AccessPolicy::from_config(
                &core.config(),
                Arc::new(crate::access::Audit::in_memory().unwrap()),
            )),
        );
        std::fs::write(directory.join("artifacts/chart.mermaid"), "graph TD\nA-->B").unwrap();
        std::fs::write(
            directory.join("artifacts/boxes.ascii"),
            "+---+\n| A |\n+---+",
        )
        .unwrap();
        std::fs::write(directory.join("artifacts/arch.drawio"), "<mxfile></mxfile>").unwrap();
        assert!(tools.collect_artifacts("solo", &persona).unwrap().is_some());
        let artifacts = core.artifacts().list("", 20, 0).unwrap();
        assert_eq!(artifacts.len(), 3);
        let filenames: Vec<&str> = artifacts.iter().map(|a| a.filename.as_str()).collect();
        assert!(filenames.contains(&"chart.mermaid"));
        assert!(filenames.contains(&"boxes.ascii"));
        assert!(filenames.contains(&"arch.drawio"));
        drop(tools);
        drop(core);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
