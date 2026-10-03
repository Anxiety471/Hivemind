pub mod catalog;
mod telemetry;
pub use telemetry::ProgressSink;
mod acp;
mod claude_code;
mod codex;
mod cursor;
mod omp;
mod opencode;
mod pi;
mod pool;
use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use pool::{
    is_rotation, InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor,
    TurnView,
};

/// A runtime-agnostic live session bound to one agent instance. Hivemind's
/// room history remains canonical; the session is a disposable cache.
#[async_trait]
pub trait HarnessSession: Send {
    fn set_progress(&mut self, _sink: Option<ProgressSink>) {}
    fn take_usage(&mut self) -> Option<crate::execution::Usage> {
        None
    }
    /// Send one user turn through the live session and return the reply.
    async fn prompt(&mut self, input: &str) -> Result<String>;
    /// Runtime-reported context size of the live session, if the runtime knows it.
    async fn context_tokens(&mut self) -> Result<Option<u64>>;
    /// Release the underlying runtime (close/kill an OMP child, etc.).
    async fn shutdown(&mut self) -> Result<()>;
}

/// Write `content` to `path` (creating parents) unless it already holds exactly that.
fn write_owned_file(path: &std::path::Path, content: &str) -> Result<()> {
    use anyhow::Context;
    if std::fs::read_to_string(path).is_ok_and(|text| text == content) {
        return Ok(());
    }
    path.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, content))
        .with_context(|| format!("writing {}", path.display()))
}

/// Hivemind's harness directory; sessions refuse to start without it rather
/// than fall back to the user's own harness setup.
fn harness_dir<'a>(
    runtime_config: &'a RuntimeConfig,
    agent: &AgentConfig,
) -> Result<&'a std::path::Path> {
    runtime_config.harness_dir.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "agent '{}' needs a Hivemind-owned harness directory (runtime.harness_dir)",
            agent.name
        )
    })
}

/// Make a runtime's reply read the same whichever runtime produced it: Unix line
/// endings, no terminal escapes or redundant blank lines, and no
/// wrapper fence around a reply that is entirely Markdown. Fenced code is kept
/// byte-for-byte apart from its line endings. Markdown hard breaks and indented
/// code whitespace are preserved.
pub fn normalize_reply(raw: &str) -> String {
    let text = strip_ansi(raw).replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<&str> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut blanks = 0;
    let mut indented_code = false;
    for line in text.split('\n') {
        let trimmed = line.trim_start();
        match fence {
            Some((ch, len)) => {
                out.push(line);
                if closes_fence(trimmed, ch, len) {
                    fence = None;
                }
            }
            None => {
                let is_indented = line.starts_with("    ") || line.starts_with('\t');
                if !line.trim().is_empty() {
                    indented_code = is_indented;
                }
                let line = if indented_code || line.ends_with("  ") {
                    line
                } else {
                    line.trim_end()
                };
                if line.trim().is_empty() {
                    blanks += 1;
                    if blanks > 1 && !indented_code {
                        continue;
                    }
                } else {
                    blanks = 0;
                    fence = opens_fence(trimmed);
                }
                out.push(line);
            }
        }
    }
    let joined = out.join("\n");
    let trimmed = joined.trim_matches('\n');
    unwrap_markdown_fence(trimmed).to_owned()
}

fn opens_fence(line: &str) -> Option<(char, usize)> {
    let ch = line.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let len = line.chars().take_while(|c| *c == ch).count();
    (len >= 3).then_some((ch, len))
}

fn closes_fence(line: &str, ch: char, len: usize) -> bool {
    let run = line.chars().take_while(|c| *c == ch).count();
    run >= len && line[run * ch.len_utf8()..].trim().is_empty()
}

/// A reply that is one ```markdown block is the Markdown itself, not a code sample.
fn unwrap_markdown_fence(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("```markdown\n")
        .or_else(|| text.strip_prefix("```md\n"))
    else {
        return text;
    };
    let Some(body) = rest.strip_suffix("\n```") else {
        return text;
    };
    // An inner fence means the outer one is not a plain wrapper.
    if body
        .lines()
        .any(|line| line.trim_start().starts_with("```"))
    {
        return text;
    }
    body.trim_matches('\n')
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// Create the live session for `agent`, dispatching on `agent.runtime`.
///
/// Every error names the agent that failed to start. No session sees the
/// user's own harness setup (extensions, skills, MCP servers, context files,
/// memory); see each adapter for how that runtime is isolated.
pub async fn create_session(
    runtime_config: &RuntimeConfig,
    agent: &AgentConfig,
) -> Result<Box<dyn HarnessSession>> {
    match agent.runtime.as_str() {
        "omp" => Ok(Box::new(
            omp::OmpSession::start_filtered(&runtime_config.omp_binary, harness_dir(runtime_config, agent)?, agent, &runtime_config.private_env).await?,
        )),
        "pi" => Ok(Box::new(
            pi::PiSession::start_filtered(&runtime_config.pi_binary, agent, &runtime_config.private_env).await?,
        )),
        "opencode" => Ok(Box::new(
            opencode::start_filtered(&runtime_config.opencode_binary, &harness_dir(runtime_config, agent)?.join("opencode"), agent, &runtime_config.private_env).await?,
        )),
        "codex" => Ok(Box::new(
            codex::start_filtered(
                &runtime_config.codex_acp_binary,
                (!runtime_config.codex_binary.is_empty())
                    .then(|| runtime_config.codex_binary.as_str()),
                agent,
                &runtime_config.private_env,
            )
            .await?,
        )),
        "claude_code" => Ok(Box::new(
            claude_code::start_filtered(
                &runtime_config.claude_code_acp_binary,
                agent,
                &runtime_config.private_env,
            )
            .await?,
        )),
        "cursor" => Ok(Box::new(
            cursor::start_filtered(
                &runtime_config.cursor_binary,
                agent,
                &runtime_config.private_env,
            )
            .await?,
        )),
        other => bail!(
            "unsupported runtime '{other}' for agent '{}'; supported runtimes are pi, omp, opencode, codex, claude_code and cursor, so change this agent's runtime",
            agent.name
        ),
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::normalize_reply;

    #[test]
    fn markdown_hard_breaks_and_indented_code_survive_normalization() {
        let raw = "first  \r\nsecond\\\r\nthird\r\n\r\n    if ready:  \r\n        run()\r\n\r\n\r\n    # literal\r\n";
        assert_eq!(
            normalize_reply(raw),
            raw.replace("\r\n", "\n").trim_end_matches('\n')
        );
    }

    #[test]
    fn plain_text_is_left_alone() {
        assert_eq!(normalize_reply("just a sentence."), "just a sentence.");
    }

    #[test]
    fn line_endings_escapes_and_blank_runs_are_normalized() {
        let raw = "\u{1b}[1mTitle\u{1b}[0m  \r\n\r\n\r\n\r\nbody\r\n";
        assert_eq!(normalize_reply(raw), "Title  \n\nbody");
    }

    #[test]
    fn code_fences_keep_their_contents() {
        let raw = "# Hi\n\n```rust\nfn main() {  \n\n\n    ok();\n}\n```\n\n\n- a\n- b";
        assert_eq!(
            normalize_reply(raw),
            "# Hi\n\n```rust\nfn main() {  \n\n\n    ok();\n}\n```\n\n- a\n- b"
        );
    }

    #[test]
    fn a_markdown_wrapper_fence_is_removed_but_real_samples_stay() {
        assert_eq!(
            normalize_reply("```markdown\n# Title\n\n- one\n```"),
            "# Title\n\n- one"
        );
        let nested = "```markdown\n# T\n```rust\nx\n```\n```";
        assert_eq!(normalize_reply(nested), nested);
        assert_eq!(normalize_reply("```md\nnot closed"), "```md\nnot closed");
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        events::EventBus,
        identity::AgentInstanceId,
        memory::{Caller, MemoryService, MemoryStore},
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(name: &str, script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hivemind-runtime-{name}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            let binary = dir.join(name);
            fs::write(
                &binary,
                format!(
                    "#!/bin/sh\nif [ \"${{HIVEMIND_FIXTURE_CHILD:-}}\" != 1 ]; then export HIVEMIND_FIXTURE_CHILD=1; exec /bin/sh -c \"$(cat $0)\"; fi\n{script}\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            Self(dir)
        }
        fn binary(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
        fn workspace(&self) -> String {
            self.0.to_string_lossy().into_owned()
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
            system_prompt: format!("Agent {name}"),
            workspace: workspace.into(),
            model: None,
            reasoning: None,
            fast: None,
            fallback_models: Vec::new(),
            role: None,
            capabilities: Vec::new(),
            permissions: Vec::new(),
            roles: Vec::new(),
            tool_access: None,
            web: true,
        }
    }

    #[tokio::test]
    async fn create_session_dispatches_two_independent_pi_agents_and_one_omp_agent() {
        let pi = Fixture::new(
            "pi",
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
    *'"type":"prompt"'*)
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi-%s"}]}}\n' "$$"
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let omp = Fixture::new(
            "omp",
            r#"
printf '%s\n' '{"type":"ready"}'
while IFS= read -r request; do
  case "$request" in
    *'"type":"prompt"'*) printf '%s\n' '{"type":"response","id":"hivemind_prompt","success":true,"data":{"agentInvoked":true}}' '{"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}' ;;
    *'"type":"get_last_assistant_text"'*) printf '%s\n' '{"type":"response","id":"hivemind_last_text","success":true,"data":{"text":"omp fixture"}}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","id":"hivemind_stats","command":"get_session_stats","success":true,"data":{}}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            omp_binary: omp.binary("omp"),
            pi_binary: pi.binary("pi"),
            harness_dir: Some(omp.0.join("harness")),
            ..RuntimeConfig::default()
        };
        let configured = [
            agent("Pi A", "pi", &pi.workspace()),
            agent("OMP", "omp", &omp.workspace()),
            agent("Pi B", "pi", &pi.workspace()),
        ];
        let mut replies = Vec::new();
        for agent in &configured {
            let mut session = create_session(&runtime, agent).await.unwrap();
            replies.push(session.prompt("hello").await.unwrap());
            session.shutdown().await.unwrap();
        }
        assert_eq!(replies[1], "omp fixture");
        assert!(replies[0].starts_with("pi-") && replies[2].starts_with("pi-"));
        assert_ne!(replies[0], replies[2]);
    }
    #[tokio::test]
    async fn runtime_pool_keeps_slash_colliding_and_related_instances_separate() {
        let pi = Fixture::new(
            "pi",
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
    *'"type":"prompt"'*)
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi-%s"}]}}\n' "$$"
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            pi_binary: pi.binary("pi"),
            idle_timeout_secs: 0,
            ..RuntimeConfig::default()
        };
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let pool = RuntimePool::new(runtime, 24_000, memory, EventBus::new());
        let identities = [
            AgentInstanceId::new("a/b", "c"),
            AgentInstanceId::new("a", "b/c"),
            AgentInstanceId::new("another-room", "c"),
            AgentInstanceId::new("a/b", "other"),
        ];
        let agents = [
            agent("c", "pi", &pi.workspace()),
            agent("b/c", "pi", &pi.workspace()),
            agent("c", "pi", &pi.workspace()),
            agent("other", "pi", &pi.workspace()),
        ];
        let view = TurnView {
            turn_id: "turn".into(),
            speakers: Vec::new(),
            state_json: "{}".into(),
        };
        let mut replies = Vec::new();
        for (agent_instance_id, agent) in identities.iter().zip(&agents) {
            let caller = Caller::agent(
                agent_instance_id.room_id.clone(),
                "",
                agent_instance_id.clone(),
                agent_instance_id.persona_id.clone(),
                agent_instance_id.persona_id.clone(),
            );
            replies.push(
                pool.invoke(
                    &caller,
                    InvokeRequest {
                        agent_instance_id,
                        agent,
                        phase: PromptPhase::TurnStart,
                        full: "hello",
                        delta: None,
                        view: &view,
                    },
                )
                .await
                .unwrap()
                .text,
            );
        }
        assert_eq!(
            replies
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            identities.len()
        );
        pool.shutdown().await;
    }

    /// Fake `opencode acp`; `prompt_body` is the shell run for each `session/prompt`.
    fn opencode_script(prompt_body: &str, startup: &str) -> String {
        format!(
            r#"
{startup}
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/^{{"id":\([0-9]*\),.*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"ses_fake"}}}}\n' "$id" ;;
    *'"method":"session/set_config_option"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/set_mode"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/delete"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
{prompt_body}
      ;;
  esac
done
"#
        )
    }

    const OPENCODE_REPLY: &str = r#"      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_thought_chunk","messageId":"m1:reasoning","content":{"type":"text","text":"thinking"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"working on it"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"opencode fixture"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"usage_update","used":4321,"size":200000}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id""#;

    fn opencode_runtime(fixture: &Fixture) -> RuntimeConfig {
        RuntimeConfig {
            opencode_binary: fixture.binary("opencode"),
            harness_dir: Some(fixture.0.join("harness")),
            ..RuntimeConfig::default()
        }
    }

    #[tokio::test]
    async fn opencode_session_returns_assistant_text_and_reported_context() {
        // Startup records the isolation env the child was given (cwd = workspace).
        let startup = r#"printf '%s|%s|%s\n' "$OPENCODE_CONFIG_DIR" "$OPENCODE_DISABLE_PROJECT_CONFIG" "${OPENCODE_CONFIG-unset}" > env"#;
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, startup));
        let mut configured = agent("Open", "opencode", &fixture.workspace());
        configured.model = Some("opencode/big-pickle".into());
        let mut session = create_session(&opencode_runtime(&fixture), &configured)
            .await
            .unwrap();
        assert_eq!(session.context_tokens().await.unwrap(), None);
        assert_eq!(session.prompt("hello").await.unwrap(), "opencode fixture");
        assert_eq!(session.context_tokens().await.unwrap(), Some(4321));
        assert_eq!(session.prompt("again").await.unwrap(), "opencode fixture");
        session.shutdown().await.unwrap();
        // The user's global and project OpenCode config never reach a Hivemind agent.
        let config_dir = fixture.0.join("harness").join("opencode");
        assert_eq!(
            fs::read_to_string(fixture.0.join("env")).unwrap(),
            format!("{}|1|unset\n", config_dir.display())
        );
        // Without any plugin OpenCode drops its built-in provider, so Hivemind keeps one.
        let plugins: Vec<_> = fs::read_dir(config_dir.join("plugins"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(plugins, ["hivemind.js"]);
    }

    #[tokio::test]
    async fn create_session_dispatches_opencode_next_to_pi_and_omp() {
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, ""));
        let omp = Fixture::new(
            "omp",
            r#"
printf '%s\n' '{"type":"ready"}'
while IFS= read -r request; do
  case "$request" in
    *'"type":"prompt"'*) printf '%s\n' '{"type":"response","id":"hivemind_prompt","success":true,"data":{"agentInvoked":true}}' '{"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}' ;;
    *'"type":"get_last_assistant_text"'*) printf '%s\n' '{"type":"response","id":"hivemind_last_text","success":true,"data":{"text":"omp fixture"}}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            omp_binary: omp.binary("omp"),
            ..opencode_runtime(&fixture)
        };
        let mut replies = Vec::new();
        for configured in [
            agent("OMP", "omp", &omp.workspace()),
            agent("Open", "opencode", &fixture.workspace()),
        ] {
            let mut session = create_session(&runtime, &configured).await.unwrap();
            replies.push(session.prompt("hello").await.unwrap());
            session.shutdown().await.unwrap();
        }
        assert_eq!(replies, ["omp fixture", "opencode fixture"]);
    }

    #[tokio::test]
    async fn opencode_start_failure_and_bad_settings_name_the_agent() {
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, ""));
        let mut runtime = opencode_runtime(&fixture);
        runtime.opencode_binary = fixture.binary("missing-opencode");
        let error = create_session(&runtime, &agent("Open", "opencode", &fixture.workspace()))
            .await
            .err()
            .unwrap();
        let error = format!("{error:#}");
        assert!(
            error.contains("Open") && error.contains("missing-opencode"),
            "{error}"
        );

        let runtime = opencode_runtime(&fixture);
        let mut fast = agent("Fast", "opencode", &fixture.workspace());
        fast.fast = Some(true);
        let error = create_session(&runtime, &fast).await.err().unwrap();
        assert!(error.to_string().contains("'fast'") && error.to_string().contains("Fast"));
        let mut reasoning = agent("Think", "opencode", &fixture.workspace());
        reasoning.reasoning = Some("high".into());
        let error = create_session(&runtime, &reasoning).await.err().unwrap();
        assert!(error.to_string().contains("'reasoning'"));
        let mut model = agent("Model", "opencode", &fixture.workspace());
        model.model = Some("no-provider".into());
        let error = create_session(&runtime, &model).await.err().unwrap();
        assert!(error.to_string().contains("provider/model-id"));
    }

    #[tokio::test]
    async fn opencode_crash_mid_prompt_poisons_the_session() {
        let fixture = Fixture::new("opencode", &opencode_script("      exit 3", ""));
        let mut session = create_session(
            &opencode_runtime(&fixture),
            &agent("Crash", "opencode", &fixture.workspace()),
        )
        .await
        .unwrap();
        let error = format!("{:#}", session.prompt("hello").await.unwrap_err());
        assert!(
            error.contains("Crash") && error.contains("exited"),
            "{error}"
        );
        let again = session.prompt("hello").await.unwrap_err().to_string();
        assert!(again.contains("failed earlier"), "{again}");
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn opencode_cancelled_turn_is_an_error_not_a_reply() {
        let body = r#"      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"cancelled"}}\n' "$id""#;
        let fixture = Fixture::new("opencode", &opencode_script(body, ""));
        let mut session = create_session(
            &opencode_runtime(&fixture),
            &agent("Deny", "opencode", &fixture.workspace()),
        )
        .await
        .unwrap();
        let error = session.prompt("hello").await.unwrap_err().to_string();
        assert!(
            error.contains("cancelled") && error.contains("Deny"),
            "{error}"
        );
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn cursor_cli_session_uses_the_same_protocol_as_opencode() {
        let fixture = Fixture::new("agent", &opencode_script(OPENCODE_REPLY, ""));
        let runtime = RuntimeConfig {
            cursor_binary: fixture.binary("agent"),
            harness_dir: Some(fixture.0.join("harness")),
            ..RuntimeConfig::default()
        };
        let mut session = create_session(&runtime, &agent("Cursor", "cursor", &fixture.workspace()))
            .await
            .unwrap();
        assert_eq!(session.prompt("hello").await.unwrap(), "opencode fixture");
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn codex_acp_session_uses_the_same_protocol_as_opencode() {
        let fixture = Fixture::new("codex-acp", &opencode_script(OPENCODE_REPLY, ""));
        let runtime = RuntimeConfig {
            codex_acp_binary: fixture.binary("codex-acp"),
            harness_dir: Some(fixture.0.join("harness")),
            ..RuntimeConfig::default()
        };
        let mut session = create_session(&runtime, &agent("Codex", "codex", &fixture.workspace()))
            .await
            .unwrap();
        assert_eq!(session.prompt("hello").await.unwrap(), "opencode fixture");
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn opencode_hanging_startup_is_killed_when_the_future_is_dropped() {
        let fixture = Fixture::new(
            "opencode",
            &opencode_script(OPENCODE_REPLY, "echo $$ > pid\nexec sleep 300"),
        );
        let runtime = opencode_runtime(&fixture);
        let configured = agent("Hang", "opencode", &fixture.workspace());
        let start = create_session(&runtime, &configured);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), start)
                .await
                .is_err()
        );
        let pid = fs::read_to_string(fixture.0.join("pid")).unwrap();
        let proc = format!("/proc/{}", pid.trim());
        for _ in 0..50 {
            if !std::path::Path::new(&proc).exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("hung opencode child {pid} survived cancellation");
    }
}
