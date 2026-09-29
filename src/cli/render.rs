use crate::setup;
use anyhow::Result;
use hivemind::config::{AgentConfig, HivemindConfig};

pub(super) fn print_agents<A: std::borrow::Borrow<AgentConfig>>(agents: &[A]) {
    println!("Agents:");
    for (i, agent) in agents.iter().enumerate() {
        let a = agent.borrow();
        println!("  {}. {} [{}]", i + 1, a.name, a.runtime);
    }
}
pub(super) fn print_order<A: std::borrow::Borrow<AgentConfig>>(agents: &[A]) {
    println!("Reply order:");
    for (i, agent) in agents.iter().enumerate() {
        println!("  {}. {}", i + 1, agent.borrow().name);
    }
}

pub(super) fn effective_agents(config: &HivemindConfig) -> Vec<&AgentConfig> {
    config.ordered_agents()
}
pub(super) fn status(config: &HivemindConfig) -> Result<()> {
    println!("Agents: {}", config.agents.len());
    println!(
        "Runtimes: {}",
        config
            .agents
            .iter()
            .map(|a| a.runtime.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("Groups:");
    for group in &config.groups {
        println!(
            "  {}: {}",
            group.name,
            if group.members.is_empty() {
                "(no agents)".into()
            } else {
                group.members.join(", ")
            }
        );
    }
    print_order(&effective_agents(config));
    for agent in &config.agents {
        let bin = match agent.runtime.as_str() {
            "omp" => &config.runtime.omp_binary,
            "pi" => &config.runtime.pi_binary,
            "opencode" => &config.runtime.opencode_binary,
            _ => continue,
        };
        println!(
            "Runtime executable '{bin}': {}",
            setup::resolve_runtime_binary(bin)
                .map_or_else(|| "not found".to_string(), |p| p.display().to_string())
        );
    }
    Ok(())
}
