//! Published artifact documents: Markdown rendered as HTML, and image wrappers,
//! both styled with the web UI's own stylesheet.

use pulldown_cmark::{
    html, BlockQuoteKind, CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};

/// The stylesheet the web UI and published artifacts share, so a published
/// artifact looks exactly like its preview in the Library.
const STYLE: &str = include_str!("../../frontend/src/content.css");

/// Markdown artifacts render as a document that mirrors the Library preview:
/// `body > main.library-doc > div.library-preview > div.markdown`.
pub(super) fn markdown_document(title: &str, markdown: &str) -> String {
    page(
        title,
        &format!(
            "<div class=\"library-preview\">\n<div class=\"markdown\">\n{}</div>\n</div>",
            render(markdown)
        ),
    )
}

/// Image artifacts render in the same frame, loading their stored bytes from
/// the same capability URL.
pub(super) fn image_document(title: &str) -> String {
    page(
        title,
        &format!(
            "<div class=\"library-preview\"><img src=\"?raw=1\" alt=\"{}\"></div>",
            escaped(title)
        ),
    )
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<main class=\"library-doc\">\n{body}\n</main>\n</body>\n</html>\n",
        escaped(title)
    )
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    pulldown_cmark_escape::escape_html(&mut out, text).expect("writing to a String cannot fail");
    out
}

/// Renders Markdown with the classes the web UI's renderer uses: wrapped
/// tables and code blocks, task-list items and GitHub-style alerts.
///
/// The event stream is transformed first and rendered in one pass: the HTML
/// writer tracks table state across events, so per-event rendering would
/// mislabel body cells as headers.
fn render(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_GFM);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let events: Vec<Event<'_>> = Parser::new_ext(markdown, options).collect();
    let (task_lists, task_items) = task_positions(&events);

    let mut rendered: Vec<Event<'_>> = Vec::with_capacity(events.len() + 8);
    let mut list_closers: Vec<Option<&'static str>> = Vec::new();
    let mut item_tasks: Vec<bool> = Vec::new();
    for (index, event) in events.into_iter().enumerate() {
        let mut prefix: Option<CowStr<'_>> = None;
        let mut suffix: Option<CowStr<'_>> = None;
        let mut replaces_event = false;
        match &event {
            Event::Start(Tag::Heading { level, .. }) => {
                prefix = Some(format!("<{}>", heading_tag(*level)).into());
                replaces_event = true;
            }
            Event::End(TagEnd::Heading(level)) => {
                prefix = Some(format!("</{}>", heading_tag(*level)).into());
                replaces_event = true;
            }
            Event::Start(Tag::Table(_)) => {
                prefix = Some("<div class=\"markdown-table-wrap\">".into())
            }
            Event::End(TagEnd::Table) => suffix = Some("</div>".into()),
            Event::Start(Tag::CodeBlock(kind)) => prefix = Some(code_header(kind)),
            Event::End(TagEnd::CodeBlock) => suffix = Some("</div>".into()),
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                prefix = Some(alert_open(*kind));
                replaces_event = true;
            }
            Event::End(TagEnd::BlockQuote(Some(_))) => {
                prefix = Some("</div></div>".into());
                replaces_event = true;
            }
            Event::Start(Tag::List(start)) => {
                if task_lists[index] {
                    let (open, close) = task_list_tags(*start);
                    prefix = Some(open.into());
                    replaces_event = true;
                    list_closers.push(Some(close));
                } else {
                    list_closers.push(None);
                }
            }
            Event::End(TagEnd::List(_)) => {
                if let Some(Some(close)) = list_closers.pop() {
                    prefix = Some(close.into());
                    replaces_event = true;
                }
            }
            Event::Start(Tag::Item) => {
                if task_items[index] {
                    prefix = Some("<li class=\"task-item\">".into());
                    replaces_event = true;
                }
                item_tasks.push(task_items[index]);
            }
            Event::End(TagEnd::Item) => {
                if item_tasks.pop().unwrap_or(false) {
                    prefix = Some("</div></li>".into());
                    replaces_event = true;
                }
            }
            Event::TaskListMarker(checked) => {
                prefix = Some(task_checkbox(*checked).into());
                replaces_event = true;
            }
            _ => {}
        }
        if let Some(prefix) = prefix {
            rendered.push(Event::Html(prefix));
        }
        if !replaces_event {
            rendered.push(event);
        }
        if let Some(suffix) = suffix {
            rendered.push(Event::Html(suffix));
        }
    }

    let mut out = String::with_capacity(markdown.len() + markdown.len() / 4 + 256);
    html::push_html(&mut out, rendered.into_iter());
    out
}

fn task_list_tags(start: Option<u64>) -> (String, &'static str) {
    match start {
        None => ("<ul class=\"task-list\">".to_owned(), "</ul>"),
        Some(1) => ("<ol class=\"task-list\">".to_owned(), "</ol>"),
        Some(start) => (
            format!("<ol class=\"task-list\" start=\"{start}\">"),
            "</ol>",
        ),
    }
}

fn task_checkbox(checked: bool) -> String {
    format!(
        "<input type=\"checkbox\" class=\"task-checkbox\"{} disabled/><div class=\"task-content\">",
        if checked { " checked" } else { "" }
    )
}

fn code_header(kind: &CodeBlockKind<'_>) -> CowStr<'static> {
    let language = match kind {
        CodeBlockKind::Fenced(language) => language.trim(),
        CodeBlockKind::Indented => "",
    };
    let mut header = String::from(
        "<div class=\"markdown-code-block\"><div class=\"markdown-code-header\"><span class=\"code-lang-tag\">",
    );
    if language.is_empty() {
        header.push_str("CODE");
    } else {
        pulldown_cmark_escape::escape_html(&mut header, &language.to_ascii_uppercase())
            .expect("writing to a String cannot fail");
    }
    header.push_str("</span></div>");
    header.into()
}

fn alert_open(kind: BlockQuoteKind) -> CowStr<'static> {
    let (kind, title, icon) = alert_meta(kind);
    format!(
        "<div class=\"markdown-alert markdown-alert-{kind}\"><div class=\"alert-header\"><span class=\"alert-icon\">{icon}</span><span class=\"alert-title\">{title}</span></div><div class=\"alert-body\">"
    )
    .into()
}

/// Event indexes of lists and items that carry a task-list marker.
fn task_positions(events: &[Event<'_>]) -> (Vec<bool>, Vec<bool>) {
    let mut lists = vec![false; events.len()];
    let mut items = vec![false; events.len()];
    let mut open_lists: Vec<usize> = Vec::new();
    let mut open_items: Vec<usize> = Vec::new();
    for (index, event) in events.iter().enumerate() {
        match event {
            Event::Start(Tag::List(_)) => open_lists.push(index),
            Event::End(TagEnd::List(_)) => {
                open_lists.pop();
            }
            Event::Start(Tag::Item) => open_items.push(index),
            Event::End(TagEnd::Item) => {
                open_items.pop();
            }
            Event::TaskListMarker(_) => {
                if let Some(list) = open_lists.last() {
                    lists[*list] = true;
                }
                if let Some(item) = open_items.last() {
                    items[*item] = true;
                }
            }
            _ => {}
        }
    }
    (lists, items)
}

/// The web UI renders Markdown headings two levels deeper (h3-h6) inside documents.
fn heading_tag(level: HeadingLevel) -> &'static str {
    match level {
        HeadingLevel::H1 => "h3",
        HeadingLevel::H2 => "h4",
        HeadingLevel::H3 => "h5",
        HeadingLevel::H4 | HeadingLevel::H5 | HeadingLevel::H6 => "h6",
    }
}

fn alert_meta(kind: BlockQuoteKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        BlockQuoteKind::Note => ("note", "Note", "ℹ️"),
        BlockQuoteKind::Tip => ("tip", "Tip", "💡"),
        BlockQuoteKind::Important => ("important", "Important", "🟣"),
        BlockQuoteKind::Warning => ("warning", "Warning", "⚠️"),
        BlockQuoteKind::Caution => ("caution", "Caution", "🛑"),
    }
}

#[cfg(test)]
mod tests {
    use super::{image_document, markdown_document};

    #[test]
    fn markdown_becomes_a_library_styled_document() {
        let page = markdown_document(
            "Release notes",
            "# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n",
        );
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<title>Release notes</title>"));
        assert!(page.contains("<main class=\"library-doc\">"));
        assert!(page.contains("<div class=\"library-preview\">"));
        assert!(page.contains("<div class=\"markdown\">"));
        assert!(page.contains("<h3>Hello</h3>"));
        assert!(page.contains("<div class=\"markdown-table-wrap\"><table>"));
        assert!(page.contains("<th>a</th>"));
        assert!(page.contains("<td>1</td>"));
        assert!(page.contains("<div class=\"markdown-code-block\">"));
        assert!(page.contains("<span class=\"code-lang-tag\">RUST</span>"));
        assert!(page.contains("fn main() {}"));
    }

    #[test]
    fn titles_and_code_are_escaped() {
        let page = markdown_document(
            "<img src=x onerror=alert(1)>",
            "`<script>alert(1)</script>`\n",
        );
        assert!(page.contains("<title>&lt;img src=x onerror=alert(1)&gt;</title>"));
        assert!(page.contains("<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>"));
    }

    #[test]
    fn alerts_and_task_lists_use_the_ui_classes() {
        let page = markdown_document(
            "Alerts",
            "> [!WARNING]\n> Careful.\n\n- [x] done\n- [ ] todo\n",
        );
        assert!(page.contains("<div class=\"markdown-alert markdown-alert-warning\">"));
        assert!(page.contains("<span class=\"alert-title\">Warning</span>"));
        assert!(page.contains("<ul class=\"task-list\">"));
        assert!(page.contains("<li class=\"task-item\">"));
        assert!(page.contains(
            "<input type=\"checkbox\" class=\"task-checkbox\" checked disabled/><div class=\"task-content\">"
        ));
    }

    #[test]
    fn images_load_their_raw_bytes_from_the_same_url() {
        let page = image_document("Diagram \"one\"");
        assert!(page.contains("<main class=\"library-doc\">"));
        assert!(page.contains("<div class=\"library-preview\"><img src=\"?raw=1\" alt=\"Diagram &quot;one&quot;\"></div>"));
    }
}
