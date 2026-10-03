import { useEffect, useState } from "react";
import { api, type LibraryArtifact } from "../api";
import { Markdown } from "../markdown";
import { Badge, Empty, ErrorNote, PageHeader, ago, useAction, useAsync } from "../ui";
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export function Library() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const data = useAsync(() => api.library(query, offset), [query, offset]);
  const [creating, setCreating] = useState(false);
  return <div className="page">
    <PageHeader title="Artifact library" sub="Files and documents saved in Hivemind, ready to reference across conversations.">
      <button className="primary" disabled={creating} onClick={() => setCreating(true)}>New artifact</button>
    </PageHeader>
    {creating && <CreateArtifact onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setOffset(0); data.reload(); }} />}
    <form className="row library-search" onSubmit={e => { e.preventDefault(); setOffset(0); if (query === search) data.reload(); else setQuery(search); }}>
      <input aria-label="Search library" placeholder="Search titles, filenames and descriptions" value={search} onChange={e => setSearch(e.target.value)} />
      <button type="submit">Search</button><button type="button" onClick={data.reload}>Refresh</button>
    </form>
    <ErrorNote error={data.error} />
    {data.data?.artifacts.length === 0 && <Empty>{query ? "No artifacts match this search." : "Your library is empty. Add a document or upload a file to get started."}</Empty>}
    <div className="cards">{data.data?.artifacts.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} onChanged={data.reload} />)}</div>
    <div className="row library-pagination"><button disabled={offset === 0 || data.loading} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
      <span className="muted">Page {Math.floor(offset / 50) + 1}</span><button disabled={data.loading || (data.data?.artifacts.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next</button></div>
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

function CreateArtifact({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
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
    await api.createLibraryArtifact({ title, filename, description, ...(file ? { content_base64 } : { content }) });
    onSaved();
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

function ArtifactCard({ artifact, onChanged }: { artifact: LibraryArtifact; onChanged: () => void }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const download = () => action.run(async () => {
    const blob = await api.libraryContent(artifact.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  return <article className="card library-artifact" data-artifact={artifact.id}>
    <div className="row"><h2 className="grow">{artifact.title}</h2><Badge value={artifact.published ? "published" : "private"} tone={artifact.published ? "ok" : "muted"} /></div>
    <p className="mono small">{artifact.filename} · {sizeLabel(artifact.size)}</p>
    {artifact.description && <p>{artifact.description}</p>}
    <p className="muted small">Saved by {artifact.persona_id || "operator"} · {ago(artifact.created_at)}{artifact.room_id ? ` · ${artifact.room_id}` : ""}</p>
    {artifact.url && <div className="library-link"><a href={artifact.url} target="_blank" rel="noopener noreferrer">Open published artifact ↗</a><input aria-label={`Published URL for ${artifact.title}`} readOnly value={artifact.url} /><button onClick={() => action.run(async () => { await navigator.clipboard.writeText(artifact.url!); setCopied(true); })}>{copied ? "Copied" : "Copy URL"}</button></div>}
    <div className="row library-controls"><button onClick={() => setPreview(!preview)}>{preview ? "Close preview" : "Preview"}</button><button disabled={action.busy} onClick={download}>Download</button>
      {artifact.published ? <button disabled={action.busy} onClick={() => action.run(async () => { await api.unpublishLibraryArtifact(artifact.id); setCopied(false); onChanged(); })}>Revoke link</button> : <button disabled={action.busy} onClick={() => action.run(async () => { await api.publishLibraryArtifact(artifact.id); onChanged(); })}>Publish link</button>}
      <button disabled={action.busy} onClick={() => setConfirming(true)}>Delete</button></div>
    <p className="hint">{artifact.published ? "Anyone holding the published URL can read this artifact. Revoke the link to stop access." : "Private: only Hivemind's operator and agents can reference this artifact."}</p>
    {preview && <Preview artifact={artifact} />}
    {confirming && <div role="alertdialog" aria-label={`Delete ${artifact.title}`}><p>Delete this artifact permanently? Its published link will stop working.</p><button className="danger" disabled={action.busy} onClick={() => action.run(async () => { await api.deleteLibraryArtifact(artifact.id); onChanged(); })}>Confirm delete</button><button onClick={() => setConfirming(false)}>Cancel</button></div>}
    <ErrorNote error={action.error} />
  </article>;
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
