import { useEffect, useState } from "react";
import { api, type LibraryArtifact } from "../api";
import { Markdown } from "../markdown";
import { href, navigate } from "../nav";
import { Badge, Empty, ErrorNote, ago, useAction, useAsync } from "../ui";
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const FILTERS: { key: "all" | Kind; label: string }[] = [
  { key: "all", label: "All" }, { key: "docs", label: "Documents" }, { key: "diagrams", label: "Diagrams" }, { key: "images", label: "Images" }, { key: "other", label: "Other" },
];

export function Library({ selected }: { selected?: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [offset, setOffset] = useState(0);
  const data = useAsync(() => api.library(query, offset), [query, offset]);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => { setOffset(0); setQuery(search); }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  const all = data.data?.artifacts ?? [];
  const list = filter === "all" ? all : all.filter(a => kindOf(a) === filter);
  const active = list.find(a => a.id === selected) ?? list[0];
  return <div className="split library-split">
    <aside className="list-pane">
      <div className="list-head">
        <h2>Artifact library</h2>
        <button className="primary small" disabled={creating} onClick={() => setCreating(true)}>New artifact</button>
      </div>
      <input className="library-search-input" type="search" aria-label="Search library" placeholder="Search titles, filenames, descriptions" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="library-filters" role="group" aria-label="Filter by type">
        {FILTERS.map(f => <button key={f.key} type="button" className={filter === f.key ? "active" : ""} onClick={() => setFilter(f.key)}>{f.label}</button>)}
      </div>
      <ErrorNote error={data.error} />
      {data.data && list.length === 0 && <Empty>{query || filter !== "all" ? "No artifacts match." : "Your library is empty. Add a document or upload a file to get started."}</Empty>}
      {list.map(a => <a key={a.id} href={href("library", a.id)} className={a.id === active?.id && !creating ? "list-item library-item active" : "list-item library-item"} onClick={() => setCreating(false)}>
        <span className="library-icon small" aria-hidden="true">{artifactIcon(a)}</span>
        <span className="library-item-body">
          <span className="list-item-title">{a.title}</span>
          <span className="muted small">{(extOf(a.filename) || "file").toUpperCase()} · {sizeLabel(a.size)} · {ago(a.created_at)}{a.published ? " · 🔗 published" : ""}</span>
        </span>
      </a>)}
      {(offset > 0 || all.length >= 50) && <div className="row library-pagination"><button disabled={offset === 0 || data.loading} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
        <span className="muted small">Page {Math.floor(offset / 50) + 1}</span><button disabled={data.loading || all.length < 50} onClick={() => setOffset(offset + 50)}>Next</button></div>}
    </aside>
    <section className="detail-pane">
      {creating
        ? <CreateArtifact onCancel={() => setCreating(false)} onSaved={a => { setCreating(false); setOffset(0); setQuery(""); setSearch(""); setFilter("all"); data.reload(); navigate("library", a.id); }} />
        : active
          ? <ArtifactDetail key={active.id} artifact={active} onChanged={data.reload} onDeleted={() => { data.reload(); navigate("library"); }} />
          : !data.loading && <div className="library-placeholder"><Empty>Select an artifact to read it here.</Empty></div>}
    </section>
  </div>;
}

const TEMPLATES: { label: string; filename: string; title: string; content: string }[] = [
  { label: "Markdown", filename: "notes.md", title: "Notes", content: "# Title\n\nWrite your document here." },
  { label: "Mermaid", filename: "diagram.mermaid", title: "Mermaid diagram", content: "graph TD\n  A[Start] --> B[Process]\n  B --> C[Done]" },
  { label: "ASCII", filename: "diagram.ascii", title: "ASCII diagram", content: "+---------+       +---------+\n| Client  | ----> | Server  |\n+---------+       +---------+" },
  { label: "Draw.io", filename: "diagram.drawio", title: "Draw.io diagram", content: `<mxfile host="app.diagrams.net">\n  <diagram name="Page-1" id="1">\n    <mxGraphModel>\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n        <mxCell id="2" value="Step 1" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">\n          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />\n        </mxCell>\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>` },
  { label: "PlantUML", filename: "diagram.puml", title: "PlantUML diagram", content: "@startuml\nactor User\nUser -> System : Request\nSystem --> User : Response\n@enduml" },
];

function isFormattedArtifact(artifact: { filename: string; media_type: string }) {
  const ext = artifact.filename.split(".").pop()?.toLowerCase() || "";
  return (
    artifact.media_type === "text/markdown" ||
    ["md", "markdown", "mermaid", "mmd", "drawio", "plantuml", "puml", "uml", "ascii"].includes(ext)
  );
}

function renderArtifactContent(artifact: { filename: string; media_type: string }, text: string) {
  const ext = artifact.filename.split(".").pop()?.toLowerCase() || "";
  if (artifact.media_type === "text/markdown" || ext === "md" || ext === "markdown") {
    return <Markdown text={text} />;
  }
  if (ext === "mermaid" || ext === "mmd") {
    return <Markdown text={"```mermaid\n" + text + "\n```"} />;
  }
  if (ext === "drawio" || (artifact.media_type === "application/xml" && text.includes("<mxfile"))) {
    return <Markdown text={"```drawio\n" + text + "\n```"} />;
  }
  if (ext === "plantuml" || ext === "puml" || ext === "uml") {
    return <Markdown text={"```plantuml\n" + text + "\n```"} />;
  }
  if (ext === "ascii") {
    return <Markdown text={"```ascii\n" + text + "\n```"} />;
  }
  return <pre>{text}</pre>;
}

function CreateArtifact({ onCancel, onSaved }: { onCancel: () => void; onSaved: (artifact: LibraryArtifact) => void }) {
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("notes.md");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const action = useAction();
  const save = () => action.run(async () => {
    let content_base64: string | undefined;
    if (file) {
      if (file.size > 8 * 1024 * 1024) throw new Error("Files must be no larger than 8 MiB.");
      content_base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.readAsDataURL(file);
      });
    }
    const res = await api.createLibraryArtifact({ title, filename, description, ...(file ? { content_base64 } : { content }) });
    onSaved(res.artifact);
  });
  return <form className="card form library-create" onSubmit={e => { e.preventDefault(); if (!action.busy) save(); }}>
    <h2>New artifact</h2>
    <div className="row template-chips" style={{ gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
      <span className="muted small" style={{ alignSelf: "center" }}>Templates:</span>
      {TEMPLATES.map(t => (
        <button
          key={t.label}
          type="button"
          className="ghost"
          style={{ padding: "2px 8px", fontSize: "11px" }}
          onClick={() => {
            setFilename(t.filename);
            if (!title || TEMPLATES.some(x => x.title === title)) setTitle(t.title);
            if (!content || TEMPLATES.some(x => x.content === content)) setContent(t.content);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
    <label>Title<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>Filename<input required value={filename} onChange={e => setFilename(e.target.value)} /></label>
    <label>Description<textarea maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>Upload file (up to 8 MiB)<input type="file" onChange={e => { const next = e.target.files?.[0] ?? null; setFile(next); if (next) { setFilename(next.name); if (!title) setTitle(next.name); } }} /></label>
    {!file && <label>Content<textarea rows={6} value={content} onChange={e => setContent(e.target.value)} placeholder="Write a document, Markdown, or HTML report…" /></label>}
    {!file && content.trim() && (
      <details style={{ marginTop: "8px", border: "1px solid var(--border)", borderRadius: "8px", padding: "8px" }}>
        <summary style={{ cursor: "pointer", fontSize: "12px", color: "var(--muted)" }}>Preview {filename}</summary>
        <div style={{ marginTop: "8px" }}>
          {renderArtifactContent({ filename, media_type: "" }, content)}
        </div>
      </details>
    )}
    <p className="muted small">Saved privately. Publish a link when you want someone to access it. Content is an immutable copy; add a new artifact for a revision.</p>
    <ErrorNote error={action.error} /><div className="row"><button className="primary" type="submit" disabled={action.busy}>Save artifact</button><button type="button" disabled={action.busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function ArtifactDetail({ artifact, onChanged, onDeleted }: { artifact: LibraryArtifact; onChanged: () => void; onDeleted: () => void }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const download = () => action.run(async () => {
    const blob = await api.libraryContent(artifact.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  const ext = extOf(artifact.filename);
  const showFilename = artifact.filename !== artifact.title;
  const where = [`Saved by ${artifact.persona_id || "operator"}`, ago(artifact.created_at), artifact.room_id].filter(Boolean).join(" · ");
  return <article className="library-doc" data-artifact={artifact.id}>
    <header className="library-doc-head">
      <div className="library-head">
        <span className="library-icon" aria-hidden="true">{artifactIcon(artifact)}</span>
        <div className="library-titles">
          <h2 title={artifact.title}>{artifact.title}</h2>
          <p className="muted small">{ext ? ext.toUpperCase() : "FILE"} · {sizeLabel(artifact.size)}{showFilename ? <> · <span className="mono">{artifact.filename}</span></> : null} · {where}</p>
        </div>
        <Badge value={artifact.published ? "published" : "private"} tone={artifact.published ? "ok" : "muted"} />
      </div>
      {artifact.description && <p className="library-desc">{artifact.description}</p>}
      <div className="row library-controls">
        <button disabled={action.busy} onClick={download}>Download</button>
        {artifact.published ? <button disabled={action.busy} title="Anyone holding the published URL can read this artifact." onClick={() => action.run(async () => { await api.unpublishLibraryArtifact(artifact.id); setCopied(false); onChanged(); })}>Revoke link</button> : <button disabled={action.busy} title="Private: only Hivemind's operator and agents can reference this artifact." onClick={() => action.run(async () => { await api.publishLibraryArtifact(artifact.id); onChanged(); })}>Publish link</button>}
        <button className="danger library-delete" disabled={action.busy} onClick={() => setConfirming(true)}>Delete</button>
      </div>
      {artifact.url && <div className="library-link"><a href={artifact.url} target="_blank" rel="noopener noreferrer">Open published artifact ↗</a><input aria-label={`Published URL for ${artifact.title}`} readOnly value={artifact.url} /><button onClick={() => action.run(async () => { await navigator.clipboard.writeText(artifact.url!); setCopied(true); })}>{copied ? "Copied" : "Copy URL"}</button></div>}
      {confirming && <div role="alertdialog" aria-label={`Delete ${artifact.title}`} className="row library-confirm"><span>Delete this artifact permanently? Its published link will stop working.</span><button className="danger" disabled={action.busy} onClick={() => action.run(async () => { await api.deleteLibraryArtifact(artifact.id); onDeleted(); })}>Confirm delete</button><button onClick={() => setConfirming(false)}>Cancel</button></div>}
      <ErrorNote error={action.error} />
    </header>
    <Preview artifact={artifact} />
  </article>;
}

const extOf = (filename: string) => filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
const DIAGRAM_EXT = ["mermaid", "mmd", "drawio", "puml", "plantuml", "uml", "ascii"];

type Kind = "docs" | "diagrams" | "images" | "other";
function kindOf(artifact: { media_type: string; filename: string }): Kind {
  const ext = extOf(artifact.filename);
  if (artifact.media_type.startsWith("image/")) return "images";
  if (DIAGRAM_EXT.includes(ext)) return "diagrams";
  if (artifact.media_type === "text/markdown" || ["md", "markdown", "txt", "html", "pdf"].includes(ext)) return "docs";
  return "other";
}

function artifactIcon(artifact: { media_type: string; filename: string }) {
  const kind = kindOf(artifact);
  const ext = extOf(artifact.filename);
  if (kind === "images") return "🖼️";
  if (kind === "diagrams") return "📊";
  if (kind === "docs") return ext === "pdf" ? "📕" : "📝";
  if (["json", "yaml", "yml", "toml", "xml", "csv"].includes(ext)) return "🗂️";
  if (["py", "js", "ts", "rs", "sh", "css", "sql"].includes(ext)) return "💻";
  return "📄";
}

function Preview({ artifact }: { artifact: LibraryArtifact }) {
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const formatted = isFormattedArtifact(artifact);

  useEffect(() => {
    let active = true;
    let url: string | undefined;
    api.libraryContent(artifact.id).then(async blob => {
      if (!active) return;
      if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(artifact.media_type)) {
        url = URL.createObjectURL(blob);
        setImage(url);
      } else if (
        artifact.media_type.startsWith("text/") ||
        artifact.media_type === "application/json" ||
        artifact.media_type === "application/xml" ||
        artifact.media_type === "image/svg+xml" ||
        /\.(md|markdown|drawio|xml|ascii|mermaid|mmd|puml|plantuml|svg|txt|json|yaml|yml|toml|py|js|ts|rs|sh|html|css|sql|csv)$/i.test(artifact.filename)
      ) {
        const value = await blob.text();
        if (active) setText(value);
      } else {
        setText("Preview is unavailable for this format. Download the file to open it.");
      }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [artifact.id, artifact.media_type, artifact.filename]);

  return (
    <div className="library-preview">
      <ErrorNote error={error} />
      {image ? (
        <img src={image} alt={artifact.title} />
      ) : text !== null ? (
        <>
          {formatted && (
            <div className="preview-toolbar">
              <button
                type="button"
                className={!raw ? "active" : ""}
                onClick={() => setRaw(false)}
                title="View rendered document/diagram"
              >
                Rendered
              </button>
              <button
                type="button"
                className={raw ? "active" : ""}
                onClick={() => setRaw(true)}
                title="View raw source"
              >
                Source
              </button>
            </div>
          )}
          {raw ? <pre>{text}</pre> : renderArtifactContent(artifact, text)}
        </>
      ) : (
        !error && <p>Loading preview…</p>
      )}
    </div>
  );
}
