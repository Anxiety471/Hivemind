//! Skills Hivemind offers its agents.
//!
//! Runtimes start with their own skill discovery switched off (see `runtime/*`), so an
//! agent only knows the skills the operator lists under `[skills] dirs`. Each directory
//! holds `<name>/SKILL.md` folders. Agents reach them through the host-bound
//! `skills.list` / `skills.read` tools; the web UI lists them through `/api/v1/skills`.
//! The directories are scanned on every call, so an added skill shows up without a restart.
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::conversation::ToolHost;

/// Longest file `skills.read` returns; the rest is cut with a notice.
const MAX_READ_BYTES: usize = 64 * 1024;
/// Skills named in the prompt manifest; `skills.list` shows all of them.
const MANIFEST_SKILLS: usize = 24;
const MANIFEST_DESCRIPTION: usize = 110;
const MAX_LISTED_FILES: usize = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
    /// Directory the skill was found in.
    pub source: String,
    #[serde(skip)]
    dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillDocument {
    pub name: String,
    pub path: String,
    pub content: String,
    pub truncated: bool,
    /// Other files shipped with the skill (relative paths, `SKILL.md` excluded).
    pub files: Vec<String>,
}

pub struct SkillCatalog {
    dirs: std::sync::RwLock<Vec<PathBuf>>,
}

fn expand(dir: &str) -> PathBuf {
    match dir.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(dir)),
        None => PathBuf::from(dir),
    }
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner;
        }
    }
    value
}

/// `name`, `description` and `argument-hint` from the `---` front matter of a SKILL.md.
fn front_matter(text: &str) -> (Option<String>, String, String) {
    let mut name = None;
    let mut description = String::new();
    let mut hint = String::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (name, description, hint);
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        // Indented lines belong to nested keys such as `metadata:`.
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let value = unquote(value).to_owned();
        match key.trim() {
            "name" if !value.is_empty() => name = Some(value),
            "description" => description = value,
            "argument-hint" | "argument_hint" => hint = value,
            _ => {}
        }
    }
    (name, description, hint)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 96
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with('.')
}

fn truncate(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max).collect();
    cut.push('…');
    cut
}

impl SkillCatalog {
    pub fn new(dirs: &[String]) -> Self {
        Self {
            dirs: std::sync::RwLock::new(dirs.iter().map(|dir| expand(dir)).collect()),
        }
    }

    pub fn set_dirs(&self, dirs: &[String]) {
        *self.dirs.write().expect("skill directory lock poisoned") =
            dirs.iter().map(|dir| expand(dir)).collect();
    }

    fn directories(&self) -> Vec<PathBuf> {
        self.dirs
            .read()
            .expect("skill directory lock poisoned")
            .clone()
    }

    pub fn is_configured(&self) -> bool {
        !self.directories().is_empty()
    }

    pub fn dirs(&self) -> Vec<String> {
        self.directories()
            .iter()
            .map(|d| d.display().to_string())
            .collect()
    }

    /// Every skill found, sorted by name; the first directory wins a duplicate name.
    pub fn list(&self) -> Vec<Skill> {
        let mut skills: Vec<Skill> = Vec::new();
        for base in self.directories() {
            let Ok(entries) = fs::read_dir(&base) else {
                continue;
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                let folder = entry.file_name().to_string_lossy().into_owned();
                let Ok(text) = fs::read_to_string(dir.join("SKILL.md")) else {
                    continue;
                };
                let (declared, description, argument_hint) = front_matter(&text);
                let name = declared.unwrap_or(folder);
                if !valid_name(&name) || skills.iter().any(|s| s.name == name) {
                    continue;
                }
                skills.push(Skill {
                    name,
                    description,
                    argument_hint,
                    source: base.display().to_string(),
                    dir,
                });
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        skills
    }

    /// Read `SKILL.md`, or another file inside the skill's folder when `path` is given.
    pub fn read(&self, name: &str, path: Option<&str>) -> Result<SkillDocument> {
        let skill = self
            .list()
            .into_iter()
            .find(|s| s.name == name)
            .with_context(|| format!("unknown skill '{name}'; call skills.list for the names"))?;
        let relative = path.map(str::trim).filter(|p| !p.is_empty());
        let relative = Path::new(relative.unwrap_or("SKILL.md"));
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            bail!("skill file paths must be relative and stay inside the skill folder");
        }
        let root = fs::canonicalize(&skill.dir).context("skill folder is not readable")?;
        let file = fs::canonicalize(root.join(relative))
            .with_context(|| format!("no file '{}' in skill '{name}'", relative.display()))?;
        if !file.starts_with(&root) {
            bail!("skill file paths must stay inside the skill folder");
        }
        let bytes = fs::read(&file).with_context(|| format!("reading {}", relative.display()))?;
        let truncated = bytes.len() > MAX_READ_BYTES;
        let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
        let content = match std::str::from_utf8(slice) {
            Ok(text) => text.to_owned(),
            // A cut inside a multi-byte character is the truncation, not a binary file.
            Err(error) if truncated && error.error_len().is_none() => {
                String::from_utf8_lossy(&slice[..error.valid_up_to()]).into_owned()
            }
            Err(_) => bail!("'{}' is not a text file", relative.display()),
        };
        Ok(SkillDocument {
            name: skill.name,
            path: relative.display().to_string(),
            content,
            truncated,
            files: skill_files(&root),
        })
    }
}

fn skill_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    if relative != Path::new("SKILL.md") {
                        out.push(relative.display().to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out.truncate(MAX_LISTED_FILES);
    out
}

/// Agent tools `skills.list` and `skills.read`, offered in every room when skills exist.
pub struct SkillTools {
    catalog: Arc<SkillCatalog>,
}

impl SkillTools {
    pub fn new(catalog: Arc<SkillCatalog>) -> Self {
        Self { catalog }
    }
}

impl ToolHost for SkillTools {
    fn manifest(&self, _room: &str, _persona: &str) -> Option<String> {
        let skills = self.catalog.list();
        if skills.is_empty() {
            return None;
        }
        let mut lines = String::new();
        for skill in skills.iter().take(MANIFEST_SKILLS) {
            lines.push_str(&format!(
                "- {}: {}\n",
                skill.name,
                truncate(&skill.description, MANIFEST_DESCRIPTION)
            ));
        }
        if skills.len() > MANIFEST_SKILLS {
            lines.push_str(&format!(
                "- … {} more (skills.list shows all)\n",
                skills.len() - MANIFEST_SKILLS
            ));
        }
        Some(format!(
            "\nHivemind skills (same ```hivemind-tool fence; one call per reply as your whole reply): skills.list() · skills.read(name, path?)\nSkills are written instructions, not tools. When a request matches one, call skills.read with its name and follow what it says; path reads another file listed in the result. Only these skills exist:\n{lines}"
        ))
    }

    fn reminder(&self, _room: &str, _persona: &str) -> Option<String> {
        self.catalog
            .is_configured()
            .then(|| "Hivemind skills.list / skills.read remain available.\n".to_owned())
    }

    fn handles(&self, name: &str) -> bool {
        matches!(name, "skills.list" | "skills.read")
    }

    fn execute(&self, _room: &str, _persona: &str, name: &str, args: &Value) -> Result<String> {
        match name {
            "skills.list" => {
                let skills = self.catalog.list();
                if skills.is_empty() {
                    return Ok("No skills are configured.".into());
                }
                Ok(skills
                    .iter()
                    .map(|s| {
                        let hint = if s.argument_hint.is_empty() {
                            String::new()
                        } else {
                            format!(" {}", s.argument_hint)
                        };
                        format!("- {}{hint}: {}", s.name, truncate(&s.description, 300))
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "skills.read" => {
                let skill = args
                    .get("name")
                    .and_then(Value::as_str)
                    .context("tool argument 'name' must be a non-empty string")?;
                let doc = self
                    .catalog
                    .read(skill, args.get("path").and_then(Value::as_str))?;
                let mut out = format!("# {} — {}\n\n{}", doc.name, doc.path, doc.content);
                if doc.truncated {
                    out.push_str("\n\n[truncated: file is larger than 64 KiB]");
                }
                if !doc.files.is_empty() {
                    out.push_str(&format!(
                        "\n\nOther files in this skill (read with path): {}",
                        doc.files.join(", ")
                    ));
                }
                Ok(out)
            }
            other => bail!("unknown skills tool '{other}'"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("hivemind-skills-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn skill(&self, folder: &str, text: &str) -> PathBuf {
            let dir = self.0.join(folder);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), text).unwrap();
            dir
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn catalog(dirs: &[&Dir]) -> SkillCatalog {
        SkillCatalog::new(
            &dirs
                .iter()
                .map(|d| d.0.display().to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn lists_front_matter_and_lets_the_first_directory_win() {
        let first = Dir::new("first");
        let second = Dir::new("second");
        first.skill(
            "banner-design",
            "---\nname: banner-design\ndescription: \"Design banners\"\nargument-hint: \"[platform]\"\nmetadata:\n  version: \"1\"\n---\n# Body\n",
        );
        second.skill("banner-design", "---\ndescription: shadowed\n---\n");
        second.skill("plain", "no front matter");
        fs::create_dir_all(second.0.join("no-skill-md")).unwrap();
        let listed = catalog(&[&first, &second]).list();
        let names: Vec<_> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["banner-design", "plain"]);
        assert_eq!(listed[0].description, "Design banners");
        assert_eq!(listed[0].argument_hint, "[platform]");
        assert_eq!(listed[1].description, "");
    }

    #[test]
    fn read_stays_inside_the_skill_folder_and_reports_siblings() {
        let dir = Dir::new("read");
        let skill = dir.skill("tidy", "---\ndescription: d\n---\nUse scripts/run.sh\n");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(skill.join("scripts/run.sh"), "echo hi\n").unwrap();
        fs::write(dir.0.join("secret.txt"), "nope").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.0.join("secret.txt"), skill.join("link.txt")).unwrap();
        let catalog = catalog(&[&dir]);

        let doc = catalog.read("tidy", None).unwrap();
        assert!(doc.content.contains("scripts/run.sh"));
        assert!(doc.files.contains(&"scripts/run.sh".to_owned()));
        assert_eq!(
            catalog
                .read("tidy", Some("scripts/run.sh"))
                .unwrap()
                .content,
            "echo hi\n"
        );

        for bad in [
            "../secret.txt",
            "/etc/passwd",
            "scripts/../../secret.txt",
            "missing.md",
        ] {
            assert!(catalog.read("tidy", Some(bad)).is_err(), "{bad}");
        }
        #[cfg(unix)]
        assert!(
            catalog.read("tidy", Some("link.txt")).is_err(),
            "symlink escape"
        );
        assert!(catalog.read("../tidy", None).is_err());
    }

    #[test]
    fn large_files_are_cut_on_a_character_boundary() {
        let dir = Dir::new("big");
        dir.skill(
            "big",
            &format!("---\ndescription: d\n---\n{}", "é".repeat(MAX_READ_BYTES)),
        );
        let doc = catalog(&[&dir]).read("big", None).unwrap();
        assert!(doc.truncated);
        assert!(doc.content.len() <= MAX_READ_BYTES);
    }

    #[test]
    fn tools_are_offered_only_when_skills_exist() {
        let dir = Dir::new("tools");
        let empty = SkillTools::new(Arc::new(catalog(&[&dir])));
        assert!(empty.manifest("main", "Engineer").is_none());
        dir.skill("brand", "---\ndescription: Brand voice\n---\nBody");
        let tools = SkillTools::new(Arc::new(catalog(&[&dir])));
        let manifest = tools.manifest("main", "Engineer").unwrap();
        assert!(manifest.contains("- brand: Brand voice"));
        let out = tools
            .execute(
                "main",
                "Engineer",
                "skills.read",
                &serde_json::json!({"name": "brand"}),
            )
            .unwrap();
        assert!(out.contains("Body"));
        assert!(tools
            .execute("main", "Engineer", "skills.read", &serde_json::json!({}))
            .is_err());
        assert!(tools.handles("skills.list") && !tools.handles("workspace.get"));
    }
}
