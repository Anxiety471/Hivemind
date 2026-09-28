use std::{
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Result};

use crate::config::{AgentConfig, HivemindConfig};

pub fn validate(config: &HivemindConfig) -> Result<()> {
    validate_with_path(config, env::var_os("PATH").as_deref())
}

fn validate_with_path(config: &HivemindConfig, path: Option<&OsStr>) -> Result<()> {
    if config.agents.is_empty() {
        bail!("config contains no agents; add at least one [[agents]] entry or create a starter config with 'hivemind init'");
    }

    for (index, agent) in config.agents.iter().enumerate() {
        if agent.name.trim().is_empty() {
            bail!("[[agents]].name must not be empty; assign each agent a non-empty name");
        }
        if config.agents[..index]
            .iter()
            .any(|previous| previous.name == agent.name)
        {
            bail!("duplicate agent name '{}'; rename one of the [[agents]] entries so every agent name is unique", agent.name);
        }
    }

    for agent in &config.agents {
        validate_agent(config, agent, path)?;
    }

    validate_reply_order(config)
}

fn validate_agent(
    config: &HivemindConfig,
    agent: &AgentConfig,
    path: Option<&OsStr>,
) -> Result<()> {
    let binary = match agent.runtime.as_str() {
        "pi" => &config.runtime.pi_binary,
        "omp" => &config.runtime.omp_binary,
        other => bail!(
            "agent '{}' uses unsupported runtime '{}' (supported: pi, omp); change this agent's runtime to 'pi' or 'omp'",
            agent.name,
            other
        ),
    };

    if resolve_binary(binary, path).is_none() {
        let location = if Path::new(binary).components().count() > 1 {
            "at configured path"
        } else {
            "on PATH"
        };
        bail!(
            "agent '{}' uses runtime '{}', but binary '{}' was not found {location}; install/configure {} or change the agent runtime",
            agent.name,
            agent.runtime,
            binary,
            agent.runtime
        );
    }

    if !Path::new(&agent.workspace).is_dir() {
        bail!(
            "agent '{}' workspace '{}' does not exist or is not a directory; create it or update the workspace setting",
            agent.name,
            agent.workspace
        );
    }
    Ok(())
}

pub fn resolve_runtime_binary(binary: &str) -> Option<PathBuf> {
    resolve_binary(binary, env::var_os("PATH").as_deref())
}

fn resolve_binary(binary: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let configured = Path::new(binary);
    if configured.components().count() > 1 || configured.is_absolute() {
        return is_executable(configured).then(|| configured.to_path_buf());
    }

    let path = path?;
    env::split_paths(path)
        .map(|directory| directory.join(configured))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn doctor(config_path: &Path, config: &HivemindConfig) -> Result<()> {
    println!("Hivemind doctor\n");
    if config.agents.is_empty() {
        println!("[error] config contains no agents; add at least one [[agents]] entry or create a starter config with 'hivemind init'");
        bail!("config contains no agents");
    }

    println!("[ok] config: {}", config_path.display());
    for agent in &config.agents {
        println!("[ok] agent: {}", agent.name);
    }

    let mut errors = 0;
    for agent in &config.agents {
        doctor_agent(config, agent, &mut errors);
    }
    match validate_reply_order(config) {
        Ok(()) => println!("[ok] conversation reply order"),
        Err(error) => {
            println!("[error] {error:#}");
            errors += 1;
        }
    }

    if errors == 0 {
        println!("[ok] runtime configuration\n[ok] ready");
        Ok(())
    } else {
        bail!("{errors} setup check(s) failed")
    }
}

fn doctor_agent(config: &HivemindConfig, agent: &AgentConfig, errors: &mut usize) {
    let binary = match agent.runtime.as_str() {
        "pi" => Some(&config.runtime.pi_binary),
        "omp" => Some(&config.runtime.omp_binary),
        other => {
            println!(
                "[error] agent '{}' uses unsupported runtime '{other}' (supported: pi, omp); change this agent's runtime to 'pi' or 'omp'",
                agent.name
            );
            *errors += 1;
            None
        }
    };

    if let Some(binary) = binary {
        if let Some(resolved) = resolve_runtime_binary(binary) {
            println!("[ok] {}: {}", agent.runtime, resolved.display());
        } else {
            let location = if Path::new(binary).components().count() > 1 {
                "at configured path"
            } else {
                "on PATH"
            };
            println!(
                "[error] agent '{}' uses runtime '{}', but binary '{}' was not found {location}; install/configure {} or change the agent runtime",
                agent.name,
                agent.runtime,
                binary,
                agent.runtime
            );
            *errors += 1;
        }
    }

    if Path::new(&agent.workspace).is_dir() {
        println!("[ok] workspace: {}", agent.workspace);
    } else {
        println!(
            "[error] agent '{}' workspace '{}' does not exist or is not a directory; create it or update the workspace setting",
            agent.name,
            agent.workspace
        );
        *errors += 1;
    }
}

fn validate_reply_order(config: &HivemindConfig) -> Result<()> {
    for (index, name) in config.conversation.reply_order.iter().enumerate() {
        if !config.agents.iter().any(|agent| agent.name == *name) {
            bail!("conversation.reply_order references unknown agent '{name}'; use unique configured agent names that match [[agents]].name");
        }
        if config.conversation.reply_order[..index]
            .iter()
            .any(|previous| previous == name)
        {
            bail!("conversation.reply_order contains duplicate agent '{name}'; use unique configured agent names");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::config::{ConversationConfig, RuntimeConfig};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "hivemind-setup-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn executable(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(name: &str, runtime: &str, workspace: &str) -> AgentConfig {
        AgentConfig {
            name: name.into(),
            runtime: runtime.into(),
            workspace: workspace.into(),
            system_prompt: String::new(),
            model: None,
            reasoning: None,
            fast: None,
        }
    }

    fn config(agents: Vec<AgentConfig>) -> HivemindConfig {
        HivemindConfig {
            runtime: RuntimeConfig::default(),
            conversation: ConversationConfig::default(),
            agents,
        }
    }

    #[test]
    fn resolves_runtime_from_injected_path_or_configured_path() {
        let fixture = Fixture::new();
        let binary = fixture.executable("pi");
        let path = OsString::from(&fixture.0);
        assert_eq!(resolve_binary("pi", Some(&path)), Some(binary.clone()));
        assert_eq!(resolve_binary("missing", Some(&path)), None);
        assert_eq!(resolve_binary(binary.to_str().unwrap(), None), Some(binary));
    }

    #[test]
    fn validates_runtime_binary_workspace_names_and_reply_order() {
        let fixture = Fixture::new();
        fixture.executable("omp");
        let path = OsString::from(&fixture.0);

        let duplicate = config(vec![agent("same", "omp", "."), agent("same", "omp", ".")]);
        assert!(validate_with_path(&duplicate, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("rename one of the [[agents]] entries"));

        let mut cfg = config(vec![agent("bad", "unknown", ".")]);
        let error = validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unsupported runtime"));
        assert!(error.contains("change this agent's runtime"));

        cfg.agents = vec![agent("missing", "pi", ".")];
        let error = validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string();
        assert!(error.contains("agent 'missing'"));
        assert!(error.contains("runtime 'pi'"));
        assert!(error.contains("binary 'pi'"));

        let file_workspace = fixture
            .executable("not-a-directory")
            .to_string_lossy()
            .into_owned();
        cfg.agents = vec![agent("bad", "omp", &file_workspace)];
        assert!(validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("workspace"));

        cfg.agents = vec![agent("A", "omp", ".")];
        cfg.conversation.reply_order = vec!["Missing".into()];
        assert!(validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("unknown agent"));
        cfg.conversation.reply_order = vec!["A".into(), "A".into()];
        assert!(validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("duplicate agent"));
    }

    #[test]
    fn valid_setup_accepts_only_referenced_runtime_and_existing_workspace() {
        let fixture = Fixture::new();
        fixture.executable("pi");
        let workspace = fixture.0.to_string_lossy().into_owned();
        let cfg = config(vec![agent("Pi agent", "pi", &workspace)]);
        validate_with_path(&cfg, Some(fixture.0.as_os_str())).unwrap();
    }

    #[test]
    fn doctor_counts_unsupported_runtime_and_missing_workspace_as_failures() {
        let fixture = Fixture::new();
        let workspace = fixture
            .0
            .join("missing-workspace")
            .to_string_lossy()
            .into_owned();
        let cfg = config(vec![agent("Bad", "unknown", &workspace)]);
        let mut errors = 0;
        doctor_agent(&cfg, &cfg.agents[0], &mut errors);
        assert_eq!(errors, 2);
    }
    #[test]
    fn doctor_accepts_resolved_runtime_and_existing_workspace() {
        let fixture = Fixture::new();
        let binary = fixture.executable("pi");
        let workspace = fixture.0.to_string_lossy().into_owned();
        let mut cfg = config(vec![agent("Pi agent", "pi", &workspace)]);
        cfg.runtime.pi_binary = binary.to_string_lossy().into_owned();

        doctor(Path::new("hivemind.toml"), &cfg).unwrap();
    }
}
