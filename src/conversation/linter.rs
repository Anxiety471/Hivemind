//! Tool and skill call linter for assistant replies.
//!
//! Validates tool call syntax, fences, JSON structure, tool availability, and
//! argument schemas before execution. Provides actionable diagnostics with
//! concrete examples so agents can correct invalid invocations within the
//! turn loop.

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::memory_tools::MemoryToolCall;

/// All recognized tool names across Hivemind (memory, workspaces, coordination).
pub const KNOWN_TOOLS: &[&str] = &[
    "memory.search",
    "memory.private.add",
    "memory.private.update",
    "memory.private.upsert",
    "memory.group.add",
    "memory.group.update",
    "memory.group.upsert",
    "memory.persona.propose",
    "memory.persona.update",
    "memory.global.propose",
    "memory.global.update",
    "memory.archive",
    "workspace.get",
    "workspace.set",
    "workspace.clear",
    "workspace.list",
    "agents.list",
    "messages.send",
    "messages.inbox",
    "messages.ack",
    "groups.create",
    "groups.get",
    "groups.members.update",
    "tasks.get",
    "tasks.list",
    "tasks.plan.propose",
    "tasks.delegate",
    "tasks.progress",
    "tasks.block",
    "tasks.result.submit",
    "tasks.review",
    "tasks.decide",
    "artifacts.get",
    "context.lookup",
    "skills.list",
    "skills.read",
];

/// Known tool name prefixes / namespaces.
pub const TOOL_NAMESPACES: &[&str] = &[
    "memory.",
    "workspace.",
    "tasks.",
    "messages.",
    "agents.",
    "groups.",
    "artifacts.",
    "skills.",
    "context.",
];

/// Whether a string matches a recognized Hivemind tool namespace.
pub fn is_known_tool_namespace(name: &str) -> bool {
    TOOL_NAMESPACES.iter().any(|p| name.starts_with(p))
}

/// Whether a string is a registered tool name.
pub fn is_known_tool(name: &str) -> bool {
    KNOWN_TOOLS.contains(&name)
}

/// Calculate Levenshtein distance between two strings.
fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();

    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for (i, row) in dp.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, item) in dp[0].iter_mut().enumerate() {
        *item = j;
    }

    for i in 1..=m {
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[m][n]
}

/// Suggest the closest valid tool name for an unknown or misspelled tool.
pub fn suggest_tool(name: &str) -> Option<&'static str> {
    // Semantic mappings for common model intuitions
    match name {
        "memory.find" | "memory.query" | "search" | "memory.get" => return Some("memory.search"),
        "memory.add" | "private.add" | "memory.create" => return Some("memory.private.add"),
        "memory.update" | "private.update" => return Some("memory.private.update"),
        "memory.upsert" | "private.upsert" => return Some("memory.private.upsert"),
        "memory.delete" | "memory.remove" | "archive" => return Some("memory.archive"),
        "workspace" | "workspace.show" | "workspace.status" => return Some("workspace.get"),
        "workspace.update" | "workspace.change" => return Some("workspace.set"),
        "workspace.roots" | "workspace.list_roots" => return Some("workspace.list"),
        "workspace.reset" => return Some("workspace.clear"),
        "tasks.plan" => return Some("tasks.plan.propose"),
        "tasks.submit" => return Some("tasks.result.submit"),
        _ => {}
    }

    // Levenshtein distance matching
    let mut best: Option<&'static str> = None;
    let mut best_dist = usize::MAX;

    for &tool in KNOWN_TOOLS {
        let dist = levenshtein_distance(name, tool);
        if dist < best_dist && dist <= 4 {
            best_dist = dist;
            best = Some(tool);
        }
    }

    best
}

/// Linter diagnostic for an invalid tool call attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolLintDiagnostic {
    pub rule: &'static str,
    pub message: String,
    pub fix: Option<String>,
}

impl std::fmt::Display for ToolLintDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "tool call error [{}]: {}", self.rule, self.message)?;
        if let Some(fix) = &self.fix {
            write!(f, "\n{fix}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ToolLintDiagnostic {}

/// Reply marker an agent starts with when asked for work outside its role.
pub const OUT_OF_SCOPE: &str = "OUT_OF_SCOPE:";

/// Whether `entry` of an agent's `unauthorized_work` forbids `tool`: the exact
/// tool name, or a namespace prefix ending in `.` (`memory.global.`).
fn forbids_tool(entry: &str, tool: &str) -> bool {
    let entry = entry.trim();
    entry == tool || (entry.ends_with('.') && tool.starts_with(entry))
}

/// Reject a tool call the agent's `unauthorized_work` rules out, with a
/// diagnostic telling it to flag the request instead of performing it.
pub fn lint_authorization(unauthorized: &[String], name: &str) -> Result<()> {
    if unauthorized.iter().any(|entry| forbids_tool(entry, name)) {
        bail!(ToolLintDiagnostic {
            rule: "authorization/not-allowed",
            message: format!("you are not authorized to use '{name}': it is listed under your unauthorized work"),
            fix: Some(format!("Do not retry. Reply with a message starting with {OUT_OF_SCOPE} that states the boundary, quotes the request, and names who should take it.")),
        });
    }
    Ok(())
}

/// The reason an agent gave for declining out-of-scope work, if its reply is one.
pub fn out_of_scope_notice(reply: &str) -> Option<&str> {
    let reply = reply.trim().trim_start_matches(['*', '`']).trim_start();
    reply
        .get(..OUT_OF_SCOPE.len())
        .filter(|head| head.eq_ignore_ascii_case(OUT_OF_SCOPE))
        .map(|_| {
            reply[OUT_OF_SCOPE.len()..]
                .trim_start_matches(['*', '`'])
                .trim()
        })
        .filter(|rest| !rest.is_empty())
}

/// Lint and validate arguments for a known tool.
pub fn lint_tool_args(name: &str, args: &Value) -> Result<()> {
    match name {
        "memory.search" => {
            let query = args.get("query").and_then(Value::as_str).map(str::trim);
            if query.is_none() || query.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: "Tool 'memory.search' requires a non-empty string argument 'query'".into(),
                    fix: Some("Example:\n```hivemind-tool\n{\"name\":\"memory.search\",\"args\":{\"query\":\"search keywords\",\"limit\":8}}\n```".into()),
                });
            }
            if let Some(limit_val) = args.get("limit") {
                match limit_val.as_u64() {
                    Some(l) if (1..=32).contains(&l) => {}
                    _ => {
                        bail!(ToolLintDiagnostic {
                            rule: "schema/invalid-argument",
                            message: "Argument 'limit' for 'memory.search' must be an integer between 1 and 32".into(),
                            fix: Some("Example: {\"query\": \"...\", \"limit\": 8}".into()),
                        });
                    }
                }
            }
            if let Some(scopes_val) = args.get("scopes") {
                match scopes_val.as_array() {
                    Some(arr) if !arr.is_empty() => {
                        for item in arr {
                            if !item.is_string() {
                                bail!(ToolLintDiagnostic {
                                    rule: "schema/invalid-argument",
                                    message: "Argument 'scopes' for 'memory.search' must be an array of strings (e.g. [\"group\", \"private\"])".into(),
                                    fix: Some("Allowed scopes: \"group\", \"private\", \"persona\", \"global\", \"archive\"".into()),
                                });
                            }
                        }
                    }
                    _ => {
                        bail!(ToolLintDiagnostic {
                            rule: "schema/invalid-argument",
                            message: "Argument 'scopes' for 'memory.search' must be a non-empty array of strings".into(),
                            fix: Some("Example: [\"group\", \"private\"]".into()),
                        });
                    }
                }
            }
        }
        "memory.private.add"
        | "memory.group.add"
        | "memory.persona.propose"
        | "memory.global.propose" => {
            let content = args.get("content").and_then(Value::as_str).map(str::trim);
            if content.is_none() || content.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: format!("Tool '{name}' requires a non-empty string argument 'content'"),
                    fix: Some(format!("Example:\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{{\"content\":\"note to store\"}}}}\n```")),
                });
            }
        }
        "memory.private.update"
        | "memory.group.update"
        | "memory.persona.update"
        | "memory.global.update" => {
            let id = args.get("id").and_then(Value::as_str).map(str::trim);
            let content = args.get("content").and_then(Value::as_str).map(str::trim);
            if id.is_none() || id.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: format!("Tool '{name}' requires a non-empty string argument 'id'"),
                    fix: Some(format!("Example:\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{{\"id\":\"<record_id>\",\"content\":\"updated content\"}}}}\n```")),
                });
            }
            if content.is_none() || content.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: format!("Tool '{name}' requires a non-empty string argument 'content'"),
                    fix: Some(format!("Example:\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{{\"id\":\"<record_id>\",\"content\":\"updated content\"}}}}\n```")),
                });
            }
        }
        "memory.private.upsert" | "memory.group.upsert" => {
            let key = args.get("key").and_then(Value::as_str).map(str::trim);
            let content = args.get("content").and_then(Value::as_str).map(str::trim);
            if key.is_none() || key.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: format!("Tool '{name}' requires a non-empty string argument 'key'"),
                    fix: Some(format!("Example:\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{{\"key\":\"short_key\",\"content\":\"note content\"}}}}\n```")),
                });
            }
            if content.is_none() || content.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: format!("Tool '{name}' requires a non-empty string argument 'content'"),
                    fix: Some(format!("Example:\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{{\"key\":\"short_key\",\"content\":\"note content\"}}}}\n```")),
                });
            }
        }
        "memory.archive" => {
            let id = args.get("id").and_then(Value::as_str).map(str::trim);
            if id.is_none() || id.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: "Tool 'memory.archive' requires a non-empty string argument 'id'".into(),
                    fix: Some("Example:\n```hivemind-tool\n{\"name\":\"memory.archive\",\"args\":{\"id\":\"<record_id>\"}}\n```".into()),
                });
            }
        }
        "workspace.set" => {
            let path = args.get("path").and_then(Value::as_str).map(str::trim);
            if path.is_none() || path.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: "Tool 'workspace.set' requires a non-empty string argument 'path'".into(),
                    fix: Some("Example:\n```hivemind-tool\n{\"name\":\"workspace.set\",\"args\":{\"path\":\"/absolute/path/to/project\"}}\n```".into()),
                });
            }
        }
        "skills.read" => {
            let skill = args.get("name").and_then(Value::as_str).map(str::trim);
            if skill.is_none() || skill.unwrap().is_empty() {
                bail!(ToolLintDiagnostic {
                    rule: "schema/missing-argument",
                    message: "Tool 'skills.read' requires a non-empty string argument 'name'".into(),
                    fix: Some("Example:\n```hivemind-tool\n{\"name\":\"skills.read\",\"args\":{\"name\":\"skill-name\"}}\n```".into()),
                });
            }
        }
        _ => {}
    }
    Ok(())
}

/// Parse and lint a JSON string into a validated `MemoryToolCall`.
pub(super) fn lint_tool_json(json_str: &str) -> Result<MemoryToolCall> {
    let value: Value =
        serde_json::from_str(json_str).context("hivemind-tool block is not valid JSON")?;
    let object = value
        .as_object()
        .context("hivemind-tool block must be a JSON object")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .context("hivemind-tool block requires a non-empty string name")?;

    if !is_known_tool(name) {
        if let Some(suggestion) = suggest_tool(name) {
            bail!(ToolLintDiagnostic {
                rule: "catalog/unknown-tool",
                message: format!("unknown tool '{name}'. Did you mean '{suggestion}'?"),
                fix: Some(format!("Available tools: {}", KNOWN_TOOLS.join(", "))),
            });
        } else if is_known_tool_namespace(name) {
            bail!(ToolLintDiagnostic {
                rule: "catalog/unknown-tool",
                message: format!("unknown tool '{name}' in recognized namespace"),
                fix: Some(format!("Available tools: {}", KNOWN_TOOLS.join(", "))),
            });
        }
    }

    let args = match object.get("args") {
        None | Some(Value::Null) => serde_json::json!({}),
        Some(args) if args.is_object() => args.clone(),
        Some(_) => bail!("hivemind-tool args must be a JSON object"),
    };

    lint_tool_args(name, &args)?;

    Ok(MemoryToolCall {
        name: name.to_owned(),
        args,
    })
}

/// Find balanced JSON object starting from the first `{` in `s`.
pub fn find_json_object(s: &str) -> Option<&str> {
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escape = false;
    let mut start_idx = None;

    for (i, c) in s.char_indices() {
        if start_idx.is_none() {
            if c == '{' {
                start_idx = Some(i);
                depth = 1;
            }
            continue;
        }

        if in_str {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_str = false;
            }
        } else {
            match c {
                '"' => in_str = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        let start = start_idx?;
                        return Some(&s[start..i + c.len_utf8()]);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Whether a line starts an unfenced tool call invocation.
pub fn is_unfenced_tool_header(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower == "hivemind-tool"
        || lower == "hivemind-tool:"
        || lower == "hivemind_tool"
        || lower == "hivemind_tool:"
        || lower == "[hivemind-tool]"
        || lower == "[hivemind_tool]"
        || lower.starts_with("hivemind-tool:")
        || lower.starts_with("hivemind-tool ")
        || lower.starts_with("hivemind-tool{")
        || lower.starts_with("hivemind_tool:")
        || lower.starts_with("hivemind_tool ")
        || lower.starts_with("hivemind_tool{")
        || lower.starts_with("[hivemind-tool]")
        || lower.starts_with("[hivemind_tool]")
}

/// Lint an assistant reply and extract exactly one tool call, returning actionable
/// diagnostic errors for formatting, schema, or tool naming issues.
pub(super) fn lint_tool_reply(text: &str) -> Result<Option<MemoryToolCall>> {
    #[derive(PartialEq)]
    enum Open<'a> {
        No,
        Fence {
            marker: char,
            len: usize,
            is_explicit: bool,
        },
        Tag {
            close_tag: &'a str,
        },
    }

    let tag_pairs: &[(&str, &str)] = &[
        ("<hivemind-tool>", "</hivemind-tool>"),
        ("<hivemind_tool>", "</hivemind_tool>"),
    ];

    let lines: Vec<&str> = text.lines().collect();
    let mut explicit_blocks: Vec<Result<MemoryToolCall>> = Vec::new();
    let mut open = Open::No;
    let mut buffer = String::new();
    let mut line_idx = 0;

    while line_idx < lines.len() {
        let line = lines[line_idx];
        let trimmed = line.trim();

        match &open {
            Open::Fence {
                marker,
                len,
                is_explicit,
            } => {
                let m = *marker;
                let l = *len;
                let explicit = *is_explicit;
                let closes = (trimmed.starts_with(m)
                    && trimmed.chars().take_while(|&c| c == m).count() >= l
                    && trimmed.trim_start_matches(m).trim().is_empty())
                    || (explicit && (trimmed == "```" || trimmed == "~~~"));

                if closes {
                    open = Open::No;
                    let content = std::mem::take(&mut buffer);
                    if explicit {
                        explicit_blocks.push(lint_tool_json(&content));
                    } else if let Ok(call) = lint_tool_json(&content) {
                        if is_known_tool(&call.name) || is_known_tool_namespace(&call.name) {
                            explicit_blocks.push(Err(anyhow::anyhow!(
                                "hivemind-tool call must be enclosed in a ```hivemind-tool fenced code block (e.g. ```hivemind-tool\n{{\"name\":\"{}\",\"args\":{{...}}}}\n```)",
                                call.name
                            )));
                        }
                    }
                    line_idx += 1;
                    continue;
                } else {
                    buffer.push_str(line);
                    buffer.push('\n');
                    line_idx += 1;
                    continue;
                }
            }
            Open::Tag { close_tag } => {
                let close = *close_tag;
                if let Some(stripped) = trimmed.strip_suffix(close) {
                    open = Open::No;
                    buffer.push_str(stripped);
                    let content = std::mem::take(&mut buffer);
                    explicit_blocks.push(lint_tool_json(&content));
                    line_idx += 1;
                    continue;
                } else {
                    buffer.push_str(line);
                    buffer.push('\n');
                    line_idx += 1;
                    continue;
                }
            }
            Open::No => {}
        }

        // Open is No: check openers
        // 1. Fence opener
        let is_fence = (trimmed.starts_with("```") || trimmed.starts_with("~~~")) && {
            let ch = trimmed.chars().next().unwrap();
            let len = trimmed.chars().take_while(|&c| c == ch).count();
            len >= 3
        };
        if is_fence {
            let ch = trimmed.chars().next().unwrap();
            let len = trimmed.chars().take_while(|&c| c == ch).count();
            let rest = trimmed[len..].trim();
            let rest_lower = rest.to_ascii_lowercase();
            let is_explicit = rest_lower == "hivemind-tool"
                || rest_lower == "hivemind_tool"
                || rest_lower.starts_with("hivemind-tool ")
                || rest_lower.starts_with("hivemind_tool ")
                || rest_lower.starts_with("hivemind-tool:")
                || rest_lower.starts_with("hivemind_tool:");
            let is_generic = !is_explicit && (rest.is_empty() || rest.eq_ignore_ascii_case("json"));
            if is_explicit || is_generic {
                open = Open::Fence {
                    marker: ch,
                    len,
                    is_explicit,
                };
                buffer.clear();
                line_idx += 1;
                continue;
            }
        }

        // 2. Tag opener
        let mut handled_tag = false;
        for &(open_tag, close_tag) in tag_pairs {
            if let Some(rest) = trimmed.strip_prefix(open_tag) {
                if let Some(body) = rest.strip_suffix(close_tag) {
                    explicit_blocks.push(lint_tool_json(body));
                } else {
                    open = Open::Tag { close_tag };
                    buffer.clear();
                    buffer.push_str(rest);
                    buffer.push('\n');
                }
                handled_tag = true;
                break;
            }
        }
        if handled_tag {
            line_idx += 1;
            continue;
        }

        // 3. Unfenced tool header
        if is_unfenced_tool_header(line) {
            let remaining = lines[line_idx..].join("\n");
            if let Some(brace_pos) = remaining.find('{') {
                let from_brace = &remaining[brace_pos..];
                if let Some(json_slice) = find_json_object(from_brace) {
                    match lint_tool_json(json_slice) {
                        Ok(call) => {
                            explicit_blocks.push(Err(anyhow::anyhow!(
                                "hivemind-tool call must be enclosed in a ```hivemind-tool fenced code block (e.g. ```hivemind-tool\n{{\"name\":\"{}\",\"args\":{{...}}}}\n```)",
                                call.name
                            )));
                        }
                        Err(error) => {
                            explicit_blocks.push(Err(error));
                        }
                    }
                    let consumed = remaining[..brace_pos + json_slice.len()].lines().count();
                    line_idx += consumed.max(1);
                    continue;
                } else {
                    explicit_blocks.push(Err(anyhow::anyhow!(
                        "hivemind-tool block is not valid JSON"
                    )));
                    line_idx += 1;
                    continue;
                }
            } else if explicit_blocks.is_empty() {
                explicit_blocks.push(Err(anyhow::anyhow!(
                    "hivemind-tool block is not valid JSON"
                )));
                line_idx += 1;
                continue;
            }
        }

        line_idx += 1;
    }

    if let Open::Tag { .. } = open {
        bail!("unterminated hivemind-tool block");
    }

    if let Open::Fence { is_explicit, .. } = open {
        if is_explicit {
            if let Ok(call) = lint_tool_json(&buffer) {
                explicit_blocks.push(Ok(call));
            } else {
                bail!("unterminated hivemind-tool block");
            }
        } else if let Ok(call) = lint_tool_json(&buffer) {
            if is_known_tool(&call.name) || is_known_tool_namespace(&call.name) {
                explicit_blocks.push(Err(anyhow::anyhow!(
                    "hivemind-tool call must be enclosed in a ```hivemind-tool fenced code block (e.g. ```hivemind-tool\n{{\"name\":\"{}\",\"args\":{{...}}}}\n```)",
                    call.name
                )));
            }
        }
    }

    let total = explicit_blocks.len();
    if total > 0 {
        if total > 1 {
            bail!("expected exactly one hivemind-tool block, found {total}");
        }
        return explicit_blocks.pop().unwrap().map(Some);
    }

    // Fallback: raw whole-message JSON matching tool namespaces
    let trimmed = text.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        if let Ok(call) = lint_tool_json(trimmed) {
            if is_known_tool(&call.name) || is_known_tool_namespace(&call.name) {
                bail!(
                    "hivemind-tool call must be enclosed in a ```hivemind-tool fenced code block (e.g. ```hivemind-tool\n{{\"name\":\"{}\",\"args\":{{...}}}}\n```)",
                    call.name
                );
            }
        }
    }

    Ok(None)
}
