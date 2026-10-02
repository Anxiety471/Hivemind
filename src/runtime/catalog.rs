//! What each runtime can run: the models it offers and the reasoning levels each accepts.
//!
//! The UI offers these instead of free text. Every listing asks the installed runtime
//! itself (its own CLI or RPC), so it reflects the credentials and providers the machine
//! really has. Nothing here starts a model turn.
use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::config::RuntimeConfig;

const LIST_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ModelEntry {
    /// The value stored on the agent (`provider/model-id`).
    pub id: String,
    pub name: String,
    pub provider: String,
    /// Reasoning levels the model accepts, best-effort; empty when it does not reason.
    pub reasoning: Vec<String>,
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Catalog {
    pub runtime: String,
    pub models: Vec<ModelEntry>,
    pub supports_reasoning: bool,
    pub supports_fast: bool,
}

pub fn is_runtime(runtime: &str) -> bool {
    matches!(runtime, "pi" | "omp" | "opencode")
}

/// List `runtime`'s models. `harness_dir` is Hivemind's runtime directory (needed so
/// OpenCode lists what its agents will actually see).
pub async fn list(config: &RuntimeConfig, runtime: &str, harness_dir: &Path) -> Result<Catalog> {
    let work = async {
        match runtime {
            "omp" => omp_models(&config.omp_binary, &config.private_env).await,
            "pi" => pi_models(&config.pi_binary, &config.private_env).await,
            "opencode" => {
                opencode_models(
                    &config.opencode_binary,
                    &harness_dir.join("opencode"),
                    &config.private_env,
                )
                .await
            }
            other => bail!("unsupported runtime '{other}'"),
        }
    };
    let mut models = timeout(LIST_TIMEOUT, work)
        .await
        .map_err(|_| anyhow!("{runtime} did not list its models within {}s", LIST_TIMEOUT.as_secs()))??;
    models.sort_by(|a, b| (&a.provider, &a.name).cmp(&(&b.provider, &b.name)));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(Catalog {
        runtime: runtime.to_owned(),
        models,
        supports_reasoning: runtime != "opencode",
        supports_fast: runtime == "omp",
    })
}

fn command(binary: &str, private_env: &[String]) -> Command {
    let mut command = Command::new(binary);
    for name in private_env {
        command.env_remove(name);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

fn spawn_error(binary: &str) -> String {
    format!("failed to run '{binary}'; is it installed and on PATH?")
}

async fn omp_models(binary: &str, private_env: &[String]) -> Result<Vec<ModelEntry>> {
    let output = command(binary, private_env)
        .args(["models", "--json", "--no-extensions"])
        .output()
        .await
        .with_context(|| spawn_error(binary))?;
    if !output.status.success() {
        bail!("'{binary} models' exited with {}", output.status);
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).context("OMP returned invalid model JSON")?;
    Ok(parsed["models"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|model| {
            let provider = model["provider"].as_str()?;
            let id = model["id"].as_str()?;
            let levels: Vec<String> = model["thinking"]
                .as_array()
                .map(|levels| levels.iter().filter_map(|l| l.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            Some(ModelEntry {
                id: model["selector"].as_str().map_or_else(|| format!("{provider}/{id}"), str::to_owned),
                name: model["name"].as_str().unwrap_or(id).to_owned(),
                provider: provider.to_owned(),
                reasoning: with_off(levels, model["reasoning"].as_bool().unwrap_or(false)),
                context_window: model["contextWindow"].as_u64(),
            })
        })
        .collect())
}

/// Pi lists whether a model reasons and which levels differ from the default
/// `minimal..high`: an explicit `null` removes a level, `xhigh`/`max` appear only when mapped.
fn pi_levels(model: &Value) -> Vec<String> {
    if !model["reasoning"].as_bool().unwrap_or(false) {
        return Vec::new();
    }
    let map = model["thinkingLevelMap"].as_object();
    let mut levels = Vec::new();
    for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
        let extended = matches!(level, "xhigh" | "max");
        let allowed = match map.and_then(|m| m.get(level)) {
            Some(value) => !value.is_null(),
            None => !extended,
        };
        if allowed {
            levels.push(level.to_owned());
        }
    }
    levels
}

fn with_off(mut levels: Vec<String>, reasons: bool) -> Vec<String> {
    if !reasons && levels.is_empty() {
        return levels;
    }
    if !levels.iter().any(|l| l == "off") {
        levels.insert(0, "off".into());
    }
    levels
}

async fn pi_models(binary: &str, private_env: &[String]) -> Result<Vec<ModelEntry>> {
    let mut rpc = Rpc::spawn(
        command(binary, private_env).args([
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
        ]),
        binary,
    )?;
    rpc.send(&json!({"type": "get_available_models", "id": "models"})).await?;
    let response = rpc
        .wait(|frame| frame["type"] == "response" && frame["id"] == "models")
        .await?;
    if response["success"] != true {
        bail!("Pi refused to list models: {}", response["error"].as_str().unwrap_or("unknown error"));
    }
    Ok(response["data"]["models"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|model| {
            let provider = model["provider"].as_str()?;
            let id = model["id"].as_str()?;
            Some(ModelEntry {
                id: format!("{provider}/{id}"),
                name: model["name"].as_str().unwrap_or(id).to_owned(),
                provider: provider.to_owned(),
                reasoning: pi_levels(model),
                context_window: model["contextWindow"].as_u64(),
            })
        })
        .collect())
}

async fn opencode_models(binary: &str, config_dir: &Path, private_env: &[String]) -> Result<Vec<ModelEntry>> {
    super::write_owned_file(
        &config_dir.join("plugins").join("hivemind.js"),
        super::opencode::KEEP_PROVIDERS_PLUGIN,
    )
    .context("preparing Hivemind's OpenCode config directory")?;
    let cwd = std::env::temp_dir();
    let mut rpc = Rpc::spawn(
        command(binary, private_env)
            .arg("acp")
            .current_dir(&cwd)
            .env("OPENCODE_CONFIG_DIR", config_dir)
            .env("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
            .env_remove("OPENCODE_CONFIG")
            .env_remove("OPENCODE_CONFIG_CONTENT"),
        binary,
    )?;
    rpc.request(1, "initialize", json!({"protocolVersion": 1, "clientCapabilities": {}})).await?;
    let created = rpc.request(2, "session/new", json!({"cwd": cwd, "mcpServers": []})).await?;
    // The probe session is not wanted in OpenCode's history.
    if let Some(session) = created["sessionId"].as_str() {
        let _ = rpc.request(3, "session/delete", json!({"sessionId": session})).await;
    }
    let options = created["configOptions"]
        .as_array()
        .and_then(|all| all.iter().find(|option| option["id"] == "model"))
        .and_then(|option| option["options"].as_array())
        .context("OpenCode did not list any models")?;
    Ok(options
        .iter()
        .filter_map(|option| {
            let id = option["value"].as_str()?;
            let (provider, _) = id.split_once('/')?;
            let name = option["name"].as_str().unwrap_or(id);
            Some(ModelEntry {
                id: id.to_owned(),
                // OpenCode names read "provider/Display Name"; the provider already has its own column.
                name: name.strip_prefix(&format!("{provider}/")).unwrap_or(name).to_owned(),
                provider: provider.to_owned(),
                reasoning: Vec::new(),
                context_window: None,
            })
        })
        .collect())
}

/// A line-delimited JSON conversation with a short-lived child.
struct Rpc {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Rpc {
    fn spawn(command: &mut Command, binary: &str) -> Result<Self> {
        let mut child = command.spawn().with_context(|| spawn_error(binary))?;
        let stdin = child.stdin.take().context("child has no stdin")?;
        let stdout = child.stdout.take().context("child has no stdout")?;
        Ok(Self { _child: child, stdin, lines: BufReader::new(stdout).lines() })
    }

    async fn send(&mut self, frame: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await.map_err(Into::into)
    }

    async fn wait(&mut self, matches: impl Fn(&Value) -> bool) -> Result<Value> {
        while let Some(line) = self.lines.next_line().await? {
            // Runtimes may print banners or logs on stdout; only JSON objects matter.
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if matches(&frame) {
                    return Ok(frame);
                }
            }
        }
        bail!("the runtime exited before answering")
    }

    /// One JSON-RPC call; returns its `result`.
    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
        let mut frame = self.wait(|frame| frame["id"] == id && frame.get("method").is_none()).await?;
        if let Some(error) = frame.get("error") {
            bail!("{method} failed: {}", error["message"].as_str().unwrap_or("unknown error"));
        }
        Ok(frame["result"].take())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_levels_follow_the_model_map() {
        let plain = json!({"reasoning": true, "thinkingLevelMap": {"minimal": "low"}});
        assert_eq!(pi_levels(&plain), ["off", "minimal", "low", "medium", "high"]);
        let extended = json!({"reasoning": true, "thinkingLevelMap": {"xhigh": "xhigh", "max": "max"}});
        assert_eq!(pi_levels(&extended), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
        let no_off = json!({"reasoning": true, "thinkingLevelMap": {"off": null, "xhigh": "xhigh"}});
        assert_eq!(pi_levels(&no_off), ["minimal", "low", "medium", "high", "xhigh"]);
        assert!(pi_levels(&json!({"reasoning": false})).is_empty());
    }

    #[test]
    fn off_is_offered_only_for_reasoning_models() {
        assert!(with_off(Vec::new(), false).is_empty());
        assert_eq!(with_off(vec!["low".into(), "high".into()], true), ["off", "low", "high"]);
    }
}
