use std::{
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Result};

use hivemind::config::HivemindConfig;

#[cfg(test)]
fn validate_with_path(config: &HivemindConfig, path: Option<&OsStr>) -> Result<()> {
    if config.agents.is_empty() {
        bail!("config contains no personas; add at least one [[personas]] entry (`[[agents]]` entries with name are accepted as a legacy alias) or create a starter config with 'hivemind init'");
    }

    for (i, persona) in config.agents.iter().enumerate() {
        if persona.name.trim().is_empty() {
            bail!("[[personas]].id must not be empty; assign each persona a non-empty id (`[[agents]].name` remains a legacy alias)");
        }
        if config.agents[..i]
            .iter()
            .any(|other| other.name == persona.name)
        {
            bail!("duplicate persona id '{}'; rename one of the [[personas]] entries (`[[agents]].name` is the legacy alias)", persona.name);
        }
    }

    for agent in &config.agents {
        validate_agent_with_path(config, agent, path)?;
    }

    for (i, name) in config.conversation.reply_order.iter().enumerate() {
        if !config.agents.iter().any(|persona| persona.name == *name) {
            bail!("conversation.reply_order references unknown persona id '{name}'; use configured [[personas]].id values (`[[agents]].name` is the legacy alias)");
        }
        if config.conversation.reply_order[..i]
            .iter()
            .any(|previous| previous == name)
        {
            bail!("conversation.reply_order contains duplicate persona id '{name}'; use unique configured persona IDs");
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_agent_with_path(
    config: &HivemindConfig,
    agent: &hivemind::config::AgentConfig,
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
        println!("[error] config contains no personas");
        bail!("config contains no personas; add at least one [[personas]] entry (`[[agents]]` entries with name are accepted as a legacy alias)");
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

fn doctor_agent(
    config: &HivemindConfig,
    agent: &hivemind::config::AgentConfig,
    errors: &mut usize,
) {
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
    for (i, name) in config.conversation.reply_order.iter().enumerate() {
        if !config.agents.iter().any(|persona| persona.name == *name) {
            bail!("conversation.reply_order references unknown persona id '{name}'; use configured [[personas]].id values (`[[agents]].name` is the legacy alias)");
        }
        if config.conversation.reply_order[..i]
            .iter()
            .any(|previous| previous == name)
        {
            bail!("conversation.reply_order contains duplicate persona id '{name}'; use unique configured persona IDs");
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
    use hivemind::config::{AgentConfig, ConversationConfig, HivemindConfig, RuntimeConfig};

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
            role: None,
        }
    }

    fn config(agents: Vec<AgentConfig>) -> HivemindConfig {
        HivemindConfig {
            runtime: RuntimeConfig::default(),
            conversation: ConversationConfig::default(),
            agents,
            groups: Vec::new(),
            context: hivemind::config::ContextConfig::default(),
            memory: Default::default(),
        }
    }

    #[test]
    fn resolves_configured_command_from_injected_path() {
        let fixture = Fixture::new();
        let binary = fixture.executable("pi");
        let path = OsString::from(&fixture.0);
        assert_eq!(resolve_binary("pi", Some(&path)), Some(binary.clone()));
        assert_eq!(resolve_binary("missing", Some(&path)), None);
        assert_eq!(resolve_binary(binary.to_str().unwrap(), None), Some(binary));
    }

    #[test]
    fn validates_duplicate_names_runtime_workspace_and_reply_order() {
        let fixture = Fixture::new();
        fixture.executable("omp");
        let path = OsString::from(&fixture.0);
        let duplicate = config(vec![agent("same", "omp", "."), agent("same", "omp", ".")]);
        assert!(validate_with_path(&duplicate, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("rename one of the [[personas]] entries"));
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
        cfg.conversation.reply_order = vec!["B".into()];
        assert!(validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("configured [[personas]].id values"));
        cfg.conversation.reply_order = vec!["A".into(), "A".into()];
        assert!(validate_with_path(&cfg, Some(&path))
            .unwrap_err()
            .to_string()
            .contains("use unique configured persona IDs"));
    }

    #[test]
    fn doctor_reports_workspace_even_when_runtime_is_unsupported() {
        let fixture = Fixture::new();
        let workspace = fixture.0.join("missing-workspace");
        let workspace = workspace.to_string_lossy().into_owned();
        let cfg = config(vec![agent("Bad", "unknown", &workspace)]);
        let mut errors = 0;

        doctor_agent(&cfg, &cfg.agents[0], &mut errors);

        assert_eq!(errors, 2);
    }
    #[test]
    fn doctor_rejects_an_empty_persona_configuration() {
        let error = doctor(Path::new("hivemind.toml"), &config(Vec::new())).unwrap_err();
        assert!(error.to_string().contains("config contains no personas"));
    }

    #[test]
    fn valid_setup_keeps_effective_order_behavior() {
        let fixture = Fixture::new();
        fixture.executable("omp");
        let workspace = fixture.0.to_string_lossy().into_owned();
        let mut cfg = config(vec![
            agent("A", "omp", &workspace),
            agent("B", "omp", &workspace),
        ]);
        cfg.conversation.reply_order = vec!["B".into()];
        validate_with_path(&cfg, Some(fixture.0.as_os_str())).unwrap();
        assert_eq!(
            cfg.ordered_agents()
                .iter()
                .map(|agent| agent.name.as_str())
                .collect::<Vec<_>>(),
            ["B", "A"]
        );
    }
}
