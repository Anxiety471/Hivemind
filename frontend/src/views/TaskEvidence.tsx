import { useState } from "react";
import { api, type TaskDetail } from "../api";
import { useRefreshOn } from "../live";
import { Badge, ErrorNote, time, useAction, useAsync } from "../ui";

function publicUrl(reference: string): string | null {
  try {
    const u = new URL(reference);
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function TaskEvidence({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const id = detail.task.id;
  const evidence = useAsync(() => api.taskEvidence(id), [id]);
  const action = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  useRefreshOn((e) => /^(task|attempt)\./.test(e.type), evidence.reload, [id, evidence.reload]);
  return (
    <>
      <ErrorNote error={evidence.error} />
      <ErrorNote error={action.error} />
      {notice && <p role="status">{notice}</p>}
      <section className="card">
        <h3>Deliverables and recovery</h3>
        {detail.artifacts.length === 0 && <p className="muted">No artifacts recorded.</p>}
        {detail.artifacts.map((a) => (
          <div key={a.id} className="card">
            <Badge value={a.kind} tone="muted" /> <strong>{a.description}</strong>
            <p className="mono small">
              {publicUrl(a.reference) ? (
                <a href={publicUrl(a.reference)!} target="_blank" rel="noreferrer">
                  {a.reference}
                </a>
              ) : (
                a.reference
              )}
            </p>
            <p className="muted small">
              {a.id} · attempt {a.attempt_id ?? "operator"}
            </p>
            {a.kind === "recovery" && (
              <div className="row">
                {["blocked", "needs_input"].includes(detail.task.status) && (
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api.taskRecovery(id, a.id, "resume");
                        onDone();
                      })
                    }
                  >
                    Resume from this recovery
                  </button>
                )}
                <button
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const result = await api.taskRecovery(id, a.id, "restore");
                      setNotice(`Restored checkout: ${result.workspace}`);
                      onDone();
                    })
                  }
                >
                  Restore checkout
                </button>
                <button
                  className="ghost"
                  disabled={action.busy}
                  onClick={() => {
                    if (
                      window.confirm("Discard this recovery from automatic restoration? Its commit remains available.")
                    )
                      action.run(async () => {
                        await api.taskRecovery(id, a.id, "discard");
                        onDone();
                      });
                  }}
                >
                  Discard recovery
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="card">
        <h3>Host verification</h3>
        <p className="muted">Host-run checks tied to the exact commit; agent-reported evidence is shown separately.</p>
        {evidence.data?.checks.length === 0 && <p>No host checks recorded.</p>}
        {evidence.data?.checks.map((c, i) => (
          <details key={i}>
            <summary>
              <Badge value={c.passed ? "passed" : "failed"} /> {c.name} ·{" "}
              <span className="mono small">{c.commit_sha}</span>
            </summary>
            <p>
              {c.command?.join(" ")} · exit {c.exit_code ?? "unavailable"}
              {c.timed_out && " · timed out"}
            </p>
            <pre>{c.stdout || c.stderr || c.error || "No output"}</pre>
            {c.stdout && c.stderr && <pre>{c.stderr}</pre>}
          </details>
        ))}
      </section>
      <section className="card">
        <h3>Decisions</h3>
        {evidence.data?.decisions.length === 0 && <p className="muted">No decisions recorded.</p>}
        {evidence.data?.decisions.map((d) => (
          <p key={d.id}>
            <Badge value={d.state} /> {d.text} <span className="muted">· {d.proposer}</span>
          </p>
        ))}
      </section>
      <section className="card">
        <h3>Task history</h3>
        <p className="muted small">Latest 200 durable events, newest first. Task room contains conversation history.</p>
        {evidence.data?.events.map((e) => (
          <details key={e.seq}>
            <summary>
              {time(e.created_at)} · {e.event_type} · {e.actor}
            </summary>
            <pre>{JSON.stringify(e.payload, null, 2)}</pre>
          </details>
        ))}
      </section>
    </>
  );
}
