//! Frontend/backend separation for generated work.
//!
//! A backend agent does logic and scripts; it must not produce frontend work
//! (UI components, styles, markup, static assets). [`classify`] sorts one file
//! into an [`Area`] from its path and, when available, its content. Node.js
//! code is the ambiguous case (`.js`/`.ts` can be a server or a browser bundle),
//! so server markers (`require('fs')`, `node:` imports, `process.argv`, a node
//! shebang, `express`, ...) identify it as backend, and browser/framework markers
//! (JSX, `document.`, `window.`, `react`, ...) identify it as frontend.
//! [`bars_frontend`] says which agents are held to this, and [`violations`] lists
//! the files an agent may not produce.

use crate::config::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Frontend,
    Backend,
    /// Docs, data, build files and other neutral work nobody owns.
    Neutral,
}

/// Always browser-side, whatever the directory.
const FRONTEND_EXTENSIONS: &[&str] = &[
    "tsx", "jsx", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl", "html", "htm",
    "hbs", "ejs", "pug", "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "woff", "woff2", "ttf",
    "otf",
];

/// Directories that hold browser-side code or assets.
const FRONTEND_DIRS: &[&str] = &[
    "frontend",
    "client",
    "ui",
    "web",
    "webapp",
    "www",
    "public",
    "static",
    "assets",
    "components",
    "styles",
    "pages",
];

/// Tooling configs that only exist for a browser build.
const FRONTEND_CONFIG_PREFIXES: &[&str] = &[
    "vite.config",
    "tailwind.config",
    "postcss.config",
    "webpack.config",
    "next.config",
    "nuxt.config",
    "svelte.config",
    "astro.config",
];

/// Extensions whose meaning depends on content or project: Node server or browser code.
const AMBIGUOUS_JS: &[&str] = &["js", "ts"];
/// Module flavours used by Node tooling and servers.
const NODE_EXTENSIONS: &[&str] = &["mjs", "cjs", "mts", "cts"];

const FRAMEWORK_DEPS: &[&str] = &[
    "react",
    "react-dom",
    "vue",
    "svelte",
    "preact",
    "solid-js",
    "@angular/core",
    "next",
    "nuxt",
    "vite",
    "lit",
];
const SERVER_DEPS: &[&str] = &[
    "express",
    "fastify",
    "koa",
    "@nestjs/core",
    "hapi",
    "@hapi/hapi",
    "restify",
    "ws",
];

/// What a `package.json` says about the JavaScript beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Project {
    Browser,
    Node,
    Unknown,
}

/// Reads `package.json` text: framework dependencies make it a browser project;
/// a server dependency, a `bin`, or an `engines.node` with no framework makes it
/// a Node project.
pub fn project_from_package_json(text: &str) -> Project {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Project::Unknown;
    };
    let has_dep = |names: &[&str]| {
        ["dependencies", "devDependencies", "peerDependencies"]
            .iter()
            .filter_map(|section| value.get(section).and_then(|d| d.as_object()))
            .any(|deps| names.iter().any(|name| deps.contains_key(*name)))
    };
    if has_dep(FRAMEWORK_DEPS) {
        Project::Browser
    } else if has_dep(SERVER_DEPS)
        || value.get("bin").is_some()
        || value.pointer("/engines/node").is_some()
    {
        Project::Node
    } else {
        Project::Unknown
    }
}

/// The nearest `package.json` at or above `rel` (a path inside `root`).
pub fn project_near(root: &std::path::Path, rel: &str) -> Project {
    let mut dir = std::path::Path::new(rel).parent();
    loop {
        let candidate = root
            .join(dir.unwrap_or_else(|| std::path::Path::new("")))
            .join("package.json");
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            return project_from_package_json(&text);
        }
        match dir {
            Some(d) if !d.as_os_str().is_empty() => dir = d.parent(),
            _ => return Project::Unknown,
        }
    }
}

fn has_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// Strongly browser-side: framework imports or JSX-looking markup.
fn framework_markers(text: &str) -> bool {
    has_any(
        text,
        &[
            "from 'react'",
            "from \"react\"",
            "require('react')",
            "from 'vue'",
            "from \"vue\"",
            "from 'svelte",
            "from \"svelte",
            "@angular/core",
            "ReactDOM",
            "createRoot(",
            "React.createElement",
            "</div>",
            "</span>",
            "/>;",
            "<>",
        ],
    )
}

/// Browser APIs a server never touches.
fn dom_markers(text: &str) -> bool {
    has_any(
        text,
        &[
            "document.",
            "window.",
            "localStorage",
            "sessionStorage",
            "addEventListener(",
            "querySelector",
            ".innerHTML",
            "navigator.",
        ],
    )
}

/// Node-only APIs and conventions.
fn node_markers(text: &str) -> bool {
    text.starts_with("#!/usr/bin/env node")
        || text.starts_with("#!/usr/bin/node")
        || has_any(
            text,
            &[
                "from 'node:",
                "from \"node:",
                "require('node:",
                "require(\"node:",
                "require('fs')",
                "require(\"fs\")",
                "require('path')",
                "require(\"path\")",
                "require('http')",
                "require('child_process')",
                "from 'fs'",
                "from \"fs\"",
                "from 'path'",
                "from \"path\"",
                "from 'http'",
                "from 'child_process'",
                "module.exports",
                "process.argv",
                "process.env",
                "process.exit",
                "__dirname",
                "from 'express'",
                "require('express')",
                "from 'fastify'",
                "from 'koa'",
                "app.listen(",
                "createServer(",
            ],
        )
}

/// Classifies `path` (repo-relative, `/` separators) and optionally its content.
/// `project` is what the nearest `package.json` says about JS/TS files.
pub fn classify(path: &str, content: Option<&str>, project: Project) -> Area {
    let path = path.trim_start_matches("./");
    let mut parts = path.split('/').collect::<Vec<_>>();
    let file = parts.pop().unwrap_or("");
    let lower = file.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if FRONTEND_EXTENSIONS.contains(&ext)
        || FRONTEND_CONFIG_PREFIXES
            .iter()
            .any(|p| lower.starts_with(p))
    {
        return Area::Frontend;
    }
    let in_frontend_dir = parts
        .iter()
        .any(|d| FRONTEND_DIRS.contains(&d.to_ascii_lowercase().as_str()));
    let is_code = AMBIGUOUS_JS.contains(&ext) || NODE_EXTENSIONS.contains(&ext);
    if NODE_EXTENSIONS.contains(&ext) && !in_frontend_dir {
        return Area::Backend;
    }
    if AMBIGUOUS_JS.contains(&ext) || (NODE_EXTENSIONS.contains(&ext) && in_frontend_dir) {
        // Content decides first: a Node server inside a mixed repo is still backend.
        if let Some(text) = content {
            if framework_markers(text) {
                return Area::Frontend;
            }
            if node_markers(text) {
                return Area::Backend;
            }
            if dom_markers(text) {
                return Area::Frontend;
            }
        }
        if in_frontend_dir {
            return Area::Frontend;
        }
        return match project {
            Project::Browser => Area::Frontend,
            Project::Node => Area::Backend,
            Project::Unknown => Area::Neutral,
        };
    }
    if in_frontend_dir && is_code {
        return Area::Frontend;
    }
    match ext {
        "rs" | "py" | "go" | "rb" | "java" | "kt" | "cs" | "php" | "sql" | "sh" | "bash"
        | "zsh" | "ps1" | "pl" | "lua" | "c" | "cc" | "cpp" | "h" | "hpp" | "toml" => Area::Backend,
        _ if !ext.is_empty() => Area::Neutral,
        // Extensionless scripts (`Makefile`, `deploy`) are neutral unless shebanged.
        _ => match content {
            Some(text) if text.starts_with("#!") => Area::Backend,
            _ => Area::Neutral,
        },
    }
}

fn is_frontend_token(entry: &str) -> bool {
    let entry = entry.trim().to_ascii_lowercase();
    let entry = entry.strip_prefix("area:").unwrap_or(&entry).trim();
    entry.starts_with("frontend")
        || entry.starts_with("front-end")
        || entry.starts_with("front end")
}

fn mentions(items: &[String], words: &[&str]) -> bool {
    items.iter().any(|item| {
        let item = item.to_ascii_lowercase();
        words.iter().any(|word| item.contains(word))
    })
}

/// Whether `agent` may not produce frontend work: it lists frontend under
/// `unauthorized_work`, or it is a backend agent (backend capability, role, or
/// authorized work) that was not also authorized for frontend or full-stack work.
pub fn bars_frontend(agent: &AgentConfig) -> bool {
    bars_frontend_for(
        &agent.capabilities,
        agent.role.as_deref(),
        &agent.authorized_work,
        &agent.unauthorized_work,
    )
}

pub fn bars_frontend_for(
    capabilities: &[String],
    role: Option<&str>,
    authorized: &[String],
    unauthorized: &[String],
) -> bool {
    const FULL: &[&str] = &[
        "frontend",
        "front-end",
        "fullstack",
        "full-stack",
        "full stack",
    ];
    if mentions(authorized, FULL) {
        return false;
    }
    if unauthorized.iter().any(|entry| is_frontend_token(entry)) {
        return true;
    }
    let backend = capabilities
        .iter()
        .any(|c| c.eq_ignore_ascii_case("backend"))
        || role.is_some_and(|r| r.to_ascii_lowercase().contains("backend"))
        || mentions(authorized, &["backend", "back-end"]);
    let also_front = mentions(capabilities, FULL)
        || role.is_some_and(|r| {
            let r = r.to_ascii_lowercase();
            FULL.iter().any(|w| r.contains(w))
        });
    backend && !also_front
}

/// One file a scoped agent produced that its role does not allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub reason: &'static str,
}

/// Frontend files among `files`. Content, when given, lets Node.js code be told
/// apart from browser code; without it a bare `.js`/`.ts` is judged by its
/// directory and `project` only.
pub fn violations(files: &[(String, Option<String>)], project: Project) -> Vec<Violation> {
    files
        .iter()
        .filter(|(path, content)| classify(path, content.as_deref(), project) == Area::Frontend)
        .map(|(path, _)| Violation {
            path: path.clone(),
            reason: "frontend work (UI code, styles, markup or assets)",
        })
        .collect()
}

/// The refusal an agent sees, naming the files and how to route the work.
pub fn message(found: &[Violation]) -> String {
    let files = found
        .iter()
        .take(8)
        .map(|v| v.path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "authorization/frontend-work: backend agents do logic and scripts only, but this includes frontend files ({files}{}). Remove them and reply starting with OUT_OF_SCOPE: so the frontend work can be routed to a frontend agent.",
        if found.len() > 8 { ", ..." } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(path: &str, content: Option<&str>) -> Area {
        classify(path, content, Project::Unknown)
    }

    #[test]
    fn paths_and_extensions_identify_frontend() {
        for path in [
            "src/App.tsx",
            "web/index.html",
            "src/styles/main.css",
            "public/logo.svg",
            "frontend/src/api.ts",
            "src/components/Button.js",
            "tailwind.config.js",
            "vite.config.ts",
        ] {
            assert_eq!(area(path, None), Area::Frontend, "{path}");
        }
    }

    #[test]
    fn logic_and_scripts_are_not_frontend() {
        for path in [
            "src/core.rs",
            "scripts/deploy.sh",
            "tools/migrate.py",
            "server/main.go",
            "db/schema.sql",
            "Cargo.toml",
        ] {
            assert_eq!(area(path, None), Area::Backend, "{path}");
        }
        for path in ["README.md", "docs/design.txt", "data.json", "Makefile"] {
            assert_eq!(area(path, None), Area::Neutral, "{path}");
        }
    }

    #[test]
    fn node_code_is_backend_by_content_extension_and_project() {
        // Node modules by extension, shebang, server imports and Node APIs.
        assert_eq!(area("tools/build.mjs", None), Area::Backend);
        assert_eq!(area("bin/run.cjs", None), Area::Backend);
        assert_eq!(
            area("cli/tool", Some("#!/usr/bin/env node\nconsole.log(1)")),
            Area::Backend
        );
        assert_eq!(
            area(
                "lib/server.js",
                Some("const fs = require('fs');\nmodule.exports = {};")
            ),
            Area::Backend
        );
        assert_eq!(
            area(
                "lib/app.ts",
                Some("import express from 'express';\napp.listen(3000)")
            ),
            Area::Backend
        );
        assert_eq!(
            area("lib/cfg.ts", Some("export const home = process.env.HOME;")),
            Area::Backend
        );
        // A Node server living under a frontend-looking directory is still backend.
        assert_eq!(
            area(
                "web/server.js",
                Some("const http = require('http');\nhttp.createServer(() => {})")
            ),
            Area::Backend
        );
        // Browser code is frontend, even in a neutral directory.
        assert_eq!(
            area(
                "lib/widget.ts",
                Some("document.querySelector('#x').innerHTML = 'hi'")
            ),
            Area::Frontend
        );
        assert_eq!(
            area(
                "lib/view.js",
                Some("import React from 'react';\nexport default () => <div/>;")
            ),
            Area::Frontend
        );
        // Plain logic is neutral on its own and follows its package.json.
        assert_eq!(
            area("lib/math.js", Some("export const add = (a, b) => a + b;")),
            Area::Neutral
        );
        assert_eq!(classify("lib/math.js", None, Project::Node), Area::Backend);
        assert_eq!(
            classify("lib/math.js", None, Project::Browser),
            Area::Frontend
        );
    }

    #[test]
    fn package_json_tells_node_projects_from_browser_ones() {
        let node = r#"{"dependencies":{"express":"^4"},"engines":{"node":">=20"}}"#;
        let bin = r#"{"name":"cli","bin":{"cli":"./cli.js"}}"#;
        let browser = r#"{"dependencies":{"react":"^19"},"devDependencies":{"vite":"^8"}}"#;
        let mixed = r#"{"dependencies":{"react":"^19","express":"^4"}}"#;
        assert_eq!(project_from_package_json(node), Project::Node);
        assert_eq!(project_from_package_json(bin), Project::Node);
        assert_eq!(project_from_package_json(browser), Project::Browser);
        assert_eq!(project_from_package_json(mixed), Project::Browser);
        assert_eq!(project_from_package_json("not json"), Project::Unknown);
        assert_eq!(project_from_package_json("{}"), Project::Unknown);
    }

    #[test]
    fn backend_agents_are_barred_unless_authorized_for_frontend() {
        let s = |items: &[&str]| items.iter().map(|i| i.to_string()).collect::<Vec<_>>();
        // Backend by capability, role, or authorized work.
        assert!(bars_frontend_for(&s(&["backend"]), None, &[], &[]));
        assert!(bars_frontend_for(&[], Some("Backend Engineer"), &[], &[]));
        assert!(bars_frontend_for(
            &[],
            None,
            &s(&["backend API implementation"]),
            &[]
        ));
        // Explicit unauthorized frontend wording.
        assert!(bars_frontend_for(
            &[],
            None,
            &[],
            &s(&["Frontend implementation"])
        ));
        assert!(bars_frontend_for(&[], None, &[], &s(&["area:frontend"])));
        // Full-stack, frontend-capable, or explicitly authorized agents are free.
        assert!(!bars_frontend_for(
            &s(&["backend", "frontend"]),
            None,
            &[],
            &[]
        ));
        assert!(!bars_frontend_for(
            &s(&["backend"]),
            Some("Full-stack dev"),
            &[],
            &[]
        ));
        assert!(!bars_frontend_for(
            &s(&["backend"]),
            None,
            &s(&["wire the frontend form"]),
            &[]
        ));
        // Unscoped agents are unaffected.
        assert!(!bars_frontend_for(&[], None, &[], &[]));
        assert!(!bars_frontend_for(&s(&["docs"]), Some("Writer"), &[], &[]));
    }

    #[test]
    fn violations_list_only_frontend_files_with_a_routable_message() {
        let files = vec![
            ("src/api.rs".to_owned(), None),
            ("src/Login.tsx".to_owned(), None),
            (
                "server.js".to_owned(),
                Some("const fs = require('fs')".to_owned()),
            ),
            ("static/app.css".to_owned(), None),
        ];
        let found = violations(&files, Project::Unknown);
        let paths: Vec<_> = found.iter().map(|v| v.path.as_str()).collect();
        assert_eq!(paths, ["src/Login.tsx", "static/app.css"]);
        let text = message(&found);
        assert!(text.contains("src/Login.tsx") && text.contains("OUT_OF_SCOPE:"));
        assert!(violations(&files[..1], Project::Unknown).is_empty());
    }
}
