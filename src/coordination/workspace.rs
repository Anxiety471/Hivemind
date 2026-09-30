//! Per-attempt git worktrees. Each work attempt edits its own branch in its
//! own directory, so parallel tasks never touch one another's files; results
//! leave as commits that dependants merge and reviewers inspect.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, Context, Result};

const IDENTITY: [&str; 4] = ["-c", "user.name=Hivemind", "-c", "user.email=hivemind@localhost"];

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(IDENTITY).arg("-C").arg(dir).args(args).output().with_context(|| format!("running git {}", args.join(" ")))?;
    if !out.status.success() {
        bail!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git").arg("-C").arg(dir).args(args).output().is_ok_and(|o| o.status.success())
}

/// Repository top-level for `workspace`, when it is inside a git work tree.
pub fn repo_top(workspace: &str) -> Option<PathBuf> {
    let dir = Path::new(workspace);
    if !dir.is_dir() {
        return None;
    }
    git(dir, &["rev-parse", "--show-toplevel"]).ok().map(PathBuf::from)
}

pub fn is_git(workspace: &str) -> bool {
    repo_top(workspace).is_some()
}

pub struct Worktree {
    pub root: PathBuf,
    /// Directory the agent works in (the workspace's sub-path inside the worktree).
    pub cwd: PathBuf,
    pub branch: Option<String>,
    /// Files whose merge from a prerequisite conflicted and await resolution.
    pub conflicts: Vec<String>,
    top: PathBuf,
    base: String,
}

/// Create a worktree for a work attempt on a fresh branch from HEAD, merging
/// each prerequisite commit. A conflicting merge is left in place with
/// markers for the agent to resolve; `conflicts` lists the files.
pub fn prepare(workspace: &str, dir: &Path, branch: &str, prerequisites: &[String]) -> Result<Worktree> {
    let top = repo_top(workspace).context("workspace is not a git repository")?;
    let prefix = git(Path::new(workspace), &["rev-parse", "--show-prefix"]).unwrap_or_default();
    std::fs::create_dir_all(dir.parent().unwrap_or(dir))?;
    git(&top, &["worktree", "add", "-b", branch, &dir.display().to_string(), "HEAD"])?;
    let base = git(dir, &["rev-parse", "HEAD"])?;
    let mut conflicts = Vec::new();
    for sha in prerequisites {
        if git(dir, &["merge", "--no-edit", "--no-ff", "-m", &format!("Merge prerequisite {sha}"), sha]).is_err() {
            let listed = git(dir, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
            conflicts.extend(listed.lines().map(str::to_owned));
            if conflicts.is_empty() {
                bail!("merging prerequisite {sha} failed without a resolvable conflict");
            }
            break;
        }
    }
    Ok(Worktree { cwd: dir.join(prefix.trim_end_matches('/')), root: dir.to_owned(), branch: Some(branch.to_owned()), conflicts, top, base })
}

/// Detached, read-only checkout of `sha` for a reviewer.
pub fn checkout_detached(workspace: &str, dir: &Path, sha: &str) -> Result<Worktree> {
    let top = repo_top(workspace).context("workspace is not a git repository")?;
    let prefix = git(Path::new(workspace), &["rev-parse", "--show-prefix"]).unwrap_or_default();
    std::fs::create_dir_all(dir.parent().unwrap_or(dir))?;
    git(&top, &["worktree", "add", "--detach", &dir.display().to_string(), sha])?;
    Ok(Worktree { cwd: dir.join(prefix.trim_end_matches('/')), root: dir.to_owned(), branch: None, conflicts: Vec::new(), top, base: sha.to_owned() })
}

pub enum Finished {
    Committed { sha: String, stat: String },
    Unchanged,
    /// Conflict markers remain in these files; nothing was committed.
    Unresolved(Vec<String>),
}

impl Worktree {
    /// Commit everything the attempt changed (concluding any merge in progress).
    pub fn finish(&self) -> Result<Finished> {
        let unresolved: Vec<String> = self
            .conflicts
            .iter()
            .filter(|file| std::fs::read_to_string(self.root.join(file)).map(|text| text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> "))).unwrap_or(false))
            .cloned()
            .collect();
        if !unresolved.is_empty() {
            return Ok(Finished::Unresolved(unresolved));
        }
        git(&self.root, &["add", "-A"])?;
        let merging = git_ok(&self.root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        let dirty = !git(&self.root, &["status", "--porcelain"])?.is_empty();
        if dirty || merging {
            git(&self.root, &["commit", "--no-verify", "-m", "Hivemind task attempt"])?;
        }
        let sha = git(&self.root, &["rev-parse", "HEAD"])?;
        if sha == self.base {
            return Ok(Finished::Unchanged);
        }
        let stat = git(&self.root, &["show", "--stat", "--format=", "HEAD"]).unwrap_or_default();
        Ok(Finished::Committed { sha, stat })
    }

    /// Remove the checkout; the branch and its commits stay for dependants.
    pub fn remove(&self) {
        let _ = git(&self.top, &["worktree", "remove", "--force", &self.root.display().to_string()]);
    }
}

/// Best-effort removal of a leftover attempt worktree (aborted or crashed
/// attempts); branches and commits are kept.
pub fn discard(dir: &Path) {
    // A linked worktree has a `.git` file; a `.git` directory (or none) means this
    // is not an attempt checkout, so never delete it.
    if !dir.join(".git").is_file() {
        return;
    }
    let common = git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok();
    if let Some(common) = common {
        let _ = Command::new("git").arg("--git-dir").arg(&common).args(["worktree", "remove", "--force"]).arg(dir).output();
    }
    let _ = std::fs::remove_dir_all(dir);
}
