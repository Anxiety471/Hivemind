//! The operator settings in `hivemind.toml`: budgets, runtimes, skill folders,
//! and the project folders agents may use. Personas, groups, and known
//! workspaces have their own editors and are left untouched.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    config::{ContextConfig, CoordinationConfig, HivemindConfig},
    execution::{validate_checks, ExecutionConfig},
};

/// The slice of `hivemind.toml` the Configure page edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorBody {
    pub context: ContextConfig,
    pub execution: ExecutionConfig,
    pub coordination: CoordinationConfig,
    pub runtime: OperatorRuntime,
    pub skills: Vec<String>,
    pub workspace_roots: Vec<String>,
}

/// Runtime knobs that belong in the file. Harness paths and private env stay internal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorRuntime {
    pub omp_binary: String,
    pub pi_binary: String,
    pub opencode_binary: String,
    pub prompt_timeout_secs: u64,
    pub idle_timeout_secs: u64,
    pub prompt_retries: u32,
}

impl OperatorRuntime {
    pub fn from_config(config: &crate::config::RuntimeConfig) -> Self {
        Self {
            omp_binary: config.omp_binary.clone(),
            pi_binary: config.pi_binary.clone(),
            opencode_binary: config.opencode_binary.clone(),
            prompt_timeout_secs: config.prompt_timeout_secs,
            idle_timeout_secs: config.idle_timeout_secs,
            prompt_retries: config.prompt_retries,
        }
    }
}

/// What the Configure page shows, including settings that need a process restart.
#[derive(Debug, Clone, Serialize)]
pub struct OperatorView {
    pub context: ContextConfig,
    pub execution: ExecutionConfig,
    pub coordination: CoordinationConfig,
    pub runtime: OperatorRuntime,
    pub skills: Vec<String>,
    pub workspace_roots: Vec<String>,
    /// Names of settings that are saved but do not take effect until `hivemind serve` starts again.
    pub restart: Vec<&'static str>,
}

impl OperatorView {
    pub fn from_config(config: &HivemindConfig, coordination_booted: bool) -> Self {
        let mut restart = Vec::new();
        if config.coordination.enabled && !coordination_booted {
            restart.push("coordination");
        }
        Self {
            context: config.context.clone(),
            execution: config.execution.clone(),
            coordination: config.coordination.clone(),
            runtime: OperatorRuntime::from_config(&config.runtime),
            skills: config.skills.dirs.clone(),
            workspace_roots: config.workspaces.roots.clone(),
            restart,
        }
    }
}

/// Copy `body` onto `config`, checking the same rules the file loader uses.
pub fn apply_to_config(config: &mut HivemindConfig, body: &OperatorBody) -> Result<()> {
    config.context = body.context.clone();
    config.execution = body.execution.clone();
    for check in &mut config.execution.checks {
        check.name = clean_line(&check.name, 64).context("verification check name")?;
        if check.command.is_empty()
            || check
                .command
                .iter()
                .any(|arg| arg.is_empty() || arg.chars().any(char::is_control))
        {
            bail!("verification checks need a command of non-empty arguments");
        }
        if check.command.len() > 32 || check.command.iter().any(|arg| arg.len() > 512) {
            bail!("verification check commands are limited to 32 arguments of 512 bytes");
        }
    }
    config.coordination = body.coordination.clone();
    if let Some(planner) = config.coordination.planner.as_deref() {
        let planner = planner.trim();
        if planner.is_empty() {
            config.coordination.planner = None;
        } else {
            config.coordination.planner = Some(planner.to_owned());
        }
    }
    let runtime = &body.runtime;
    config.runtime.omp_binary = binary("omp_binary", &runtime.omp_binary)?;
    config.runtime.pi_binary = binary("pi_binary", &runtime.pi_binary)?;
    config.runtime.opencode_binary = binary("opencode_binary", &runtime.opencode_binary)?;
    config.runtime.prompt_timeout_secs = runtime.prompt_timeout_secs;
    config.runtime.idle_timeout_secs = runtime.idle_timeout_secs;
    config.runtime.prompt_retries = runtime.prompt_retries;
    config.skills.dirs = body
        .skills
        .iter()
        .map(|dir| skill_dir(dir))
        .collect::<Result<_>>()?;
    if config.skills.dirs.len() > 32 {
        bail!("you can list up to 32 skill directories");
    }
    let mut seen = std::collections::HashSet::new();
    config.skills.dirs.retain(|dir| seen.insert(dir.clone()));
    config.workspaces.roots = body
        .workspace_roots
        .iter()
        .map(|root| project_folder(root))
        .collect::<Result<_>>()?;
    if config.workspaces.roots.len() > 32 {
        bail!("you can list up to 32 project folders");
    }
    let mut seen = std::collections::HashSet::new();
    if !config
        .workspaces
        .roots
        .iter()
        .all(|root| seen.insert(root.clone()))
    {
        bail!("project folders must be unique");
    }
    validate_checks(&config.execution)?;
    config.validate()?;
    Ok(())
}

fn clean_line(value: &str, max: usize) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max || trimmed.chars().any(char::is_control)
    {
        bail!("use a short name without blank lines");
    }
    Ok(trimmed.to_owned())
}

fn binary(field: &str, value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        bail!("{field} must be a program name or path");
    }
    Ok(trimmed.to_owned())
}

fn skill_dir(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
        bail!("skill directories must be absolute paths or start with ~/");
    }
    if !(trimmed.starts_with('/') || trimmed.starts_with("~/") || trimmed == "~") {
        bail!("skill directory '{trimmed}' must be absolute or start with ~/");
    }
    if trimmed.split('/').any(|part| part == "..") {
        bail!("skill directory '{trimmed}' must not contain '..'");
    }
    Ok(trimmed.to_owned())
}

fn project_folder(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains("..") || !Path::new(trimmed).is_absolute() {
        bail!("project folder '{trimmed}' must be an absolute path");
    }
    let real = std::fs::canonicalize(trimmed)
        .ok()
        .filter(|path| path.is_dir())
        .with_context(|| format!("'{trimmed}' does not exist or is not a directory"))?;
    Ok(real.display().to_string())
}

/// Write the operator sections into `document`, leaving every other key and comment in place.
pub fn write_document(
    document: &mut toml_edit::DocumentMut,
    config: &HivemindConfig,
) -> Result<()> {
    let context = table(document, "context")?;
    set_usize(context, "recent_turns", config.context.recent_turns)?;
    set_usize(
        context,
        "summary_max_tokens",
        config.context.summary_max_tokens,
    )?;
    set_usize(
        context,
        "context_target_tokens",
        config.context.context_target_tokens,
    )?;
    set_usize(
        context,
        "runtime_rotate_tokens",
        config.context.runtime_rotate_tokens,
    )?;
    set_usize(
        context,
        "summary_refresh_turns",
        config.context.summary_refresh_turns,
    )?;

    let execution = table(document, "execution")?;
    set_u64(
        execution,
        "task_token_limit",
        config.execution.task_token_limit,
    )?;
    set_u64(
        execution,
        "project_token_limit",
        config.execution.project_token_limit,
    )?;
    execution["require_usage"] = toml_edit::value(config.execution.require_usage);
    if config.execution.checks.is_empty() {
        execution.remove("checks");
    } else {
        let mut checks = toml_edit::ArrayOfTables::new();
        for check in &config.execution.checks {
            let mut row = toml_edit::Table::new();
            row["name"] = toml_edit::value(&check.name);
            row["command"] = toml_edit::value(check.command.iter().collect::<toml_edit::Array>());
            set_u64(&mut row, "timeout_secs", check.timeout_secs)?;
            checks.push(row);
        }
        execution["checks"] = toml_edit::Item::ArrayOfTables(checks);
    }

    let coordination = table(document, "coordination")?;
    coordination["enabled"] = toml_edit::value(config.coordination.enabled);
    match &config.coordination.planner {
        Some(planner) => coordination["planner"] = toml_edit::value(planner),
        None => {
            coordination.remove("planner");
        }
    }
    set_u64(
        coordination,
        "max_dispatches",
        config.coordination.max_dispatches as u64,
    )?;
    set_u64(
        coordination,
        "max_tool_actions",
        config.coordination.max_tool_actions as u64,
    )?;
    set_u64(
        coordination,
        "max_messages",
        config.coordination.max_messages as u64,
    )?;
    set_usize(
        coordination,
        "max_plan_tasks",
        config.coordination.max_plan_tasks,
    )?;
    set_usize(
        coordination,
        "max_plan_depth",
        config.coordination.max_plan_depth,
    )?;
    set_u64(
        coordination,
        "max_elapsed_secs",
        config.coordination.max_elapsed_secs,
    )?;
    set_u64(
        coordination,
        "max_attempts_per_task",
        config.coordination.max_attempts_per_task as u64,
    )?;
    set_usize(
        coordination,
        "max_concurrent",
        config.coordination.max_concurrent,
    )?;
    set_u64(coordination, "lease_secs", config.coordination.lease_secs)?;
    set_u64(
        coordination,
        "max_message_depth",
        config.coordination.max_message_depth as u64,
    )?;
    set_u64(
        coordination,
        "question_timeout_secs",
        config.coordination.question_timeout_secs,
    )?;
    set_u64(
        coordination,
        "max_questions",
        config.coordination.max_questions as u64,
    )?;

    let runtime = table(document, "runtime")?;
    runtime["omp_binary"] = toml_edit::value(&config.runtime.omp_binary);
    runtime["pi_binary"] = toml_edit::value(&config.runtime.pi_binary);
    runtime["opencode_binary"] = toml_edit::value(&config.runtime.opencode_binary);
    set_u64(
        runtime,
        "prompt_timeout_secs",
        config.runtime.prompt_timeout_secs,
    )?;
    set_u64(
        runtime,
        "idle_timeout_secs",
        config.runtime.idle_timeout_secs,
    )?;
    set_u64(
        runtime,
        "prompt_retries",
        config.runtime.prompt_retries as u64,
    )?;

    let skills = table(document, "skills")?;
    skills["dirs"] = toml_edit::value(config.skills.dirs.iter().collect::<toml_edit::Array>());

    let workspaces = table(document, "workspaces")?;
    workspaces["roots"] =
        toml_edit::value(config.workspaces.roots.iter().collect::<toml_edit::Array>());
    Ok(())
}

fn table<'a>(
    document: &'a mut toml_edit::DocumentMut,
    key: &str,
) -> Result<&'a mut toml_edit::Table> {
    document
        .entry(key)
        .or_insert_with(toml_edit::table)
        .as_table_mut()
        .with_context(|| format!("[{key}] is not a table"))
}

fn set_usize(table: &mut toml_edit::Table, key: &str, value: usize) -> Result<()> {
    let value = i64::try_from(value).with_context(|| format!("{key} is too large"))?;
    table[key] = toml_edit::value(value);
    Ok(())
}

fn set_u64(table: &mut toml_edit::Table, key: &str, value: u64) -> Result<()> {
    let value = i64::try_from(value).with_context(|| format!("{key} is too large"))?;
    table[key] = toml_edit::value(value);
    Ok(())
}
