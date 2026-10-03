import { useEffect, useState } from "react";
import { api } from "../api";
import { useRefreshOn } from "../live";
import { ErrorNote, PageHeader, time, useAsync } from "../ui";

export function UsageView() {
  const [scope, setScope] = useState("");
  const [project, setProject] = useState("");
  const [filters, setFilters] = useState({ scope: "", project: "" });
  return (
    <div className="page task-detail">
      <PageHeader title="Usage and limits" sub="Measured tokens, unknown reporting, and persistent admission limits." />
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ scope: scope.trim(), project: project.trim() });
        }}
      >
        <label>
          Task or room scope
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="All scopes" />
        </label>
        <label>
          Project workspace
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="All projects" />
        </label>
        <button>Apply filters</button>
      </form>
      <UsagePanel scope={filters.scope || undefined} project={filters.project || undefined} />
    </div>
  );
}
export function UsagePanel({ scope, project }: { scope?: string; project?: string }) {
  const report = useAsync(() => api.measuredUsage(scope, project), [scope, project]);
  useRefreshOn((e) => /^(agent|task|attempt|conversation)\./.test(e.type), report.reload, [report.reload]);
  useEffect(() => {
    const timer = window.setInterval(report.reload, 5000);
    return () => clearInterval(timer);
  }, [report.reload]);
  const data = report.data;
  return (
    <section className="card">
      <h3>Measured runtime usage</h3>
      <ErrorNote error={report.error} />
      {data && (
        <>
          <div className="facts">
            <div className="fact">
              <div className="fact-label">Reported tokens</div>
              <strong>{data.measured_tokens.toLocaleString()}</strong>
            </div>
            <div className="fact">
              <div className="fact-label">Unknown prompts</div>
              <strong>{data.unknown_prompts}</strong>
            </div>
          </div>
          {data.unknown_prompts > 0 && (
            <p className="callout">Some prompts have unknown usage. The measured total excludes them.</p>
          )}
          {data.usage_blocked && (
            <p className="callout" role="alert">
              Unknown usage is blocking further prompts in affected scopes or projects.
            </p>
          )}
          {scope && (
            <p>
              Scope admission total: {(data.scope_budget_tokens ?? data.measured_tokens).toLocaleString()} · limit{" "}
              {data.task_token_limit ? data.task_token_limit.toLocaleString() : "disabled"} · {data.scope_budget_state}
            </p>
          )}
          {data.scope_budget_state === "warning" && (
            <p className="callout" role="alert">
              This scope has used at least 80% of its measured token limit.
            </p>
          )}
          {data.scope_budget_state === "exhausted" && (
            <p className="callout" role="alert">
              Scope token limit reached; new prompts are blocked.
            </p>
          )}
          <h4>By persona in this selection</h4>
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Reported tokens</th>
                <th>Unknown prompts</th>
              </tr>
            </thead>
            <tbody>
              {data.by_persona.map((p) => (
                <tr key={p.persona}>
                  <td>{p.persona}</td>
                  <td>{p.measured_tokens.toLocaleString()}</td>
                  <td>{p.unknown_prompts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Project budgets across all tasks</h4>
          <p className="muted small">
            Project admission uses the entire project history, even when filtering one task.
          </p>
          {data.by_project.map((p) => (
            <div key={p.project}>
              <p className="mono small">{p.project}</p>
              <p>
                {p.measured_tokens.toLocaleString()} reported tokens · limit{" "}
                {p.limit ? p.limit.toLocaleString() : "disabled"} · {p.budget_state} · {p.unknown_prompts} unknown
                prompts
              </p>
              {p.budget_state === "warning" && (
                <p className="callout" role="alert">
                  Project has used at least 80% of its limit.
                </p>
              )}
              {(p.budget_state === "exhausted" || p.usage_blocked) && (
                <p className="callout" role="alert">
                  Project dispatch is blocked:{" "}
                  {p.usage_blocked ? "required usage is unavailable" : "measured token limit reached"}.
                </p>
              )}
            </div>
          ))}
          <details>
            <summary>Latest 200 prompt records</summary>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Persona</th>
                  <th>Scope</th>
                  <th>Input / output / cache read / cache write</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((r, i) => (
                  <tr key={`${r.turn_id}-${r.epoch}-${i}`}>
                    <td>{time(r.created_at)}</td>
                    <td>{r.persona}</td>
                    <td className="mono small">{r.scope}</td>
                    <td>
                      {r.usage
                        ? `${r.usage.input_tokens} / ${r.usage.output_tokens} / ${r.usage.cache_read_tokens} / ${r.usage.cache_write_tokens}`
                        : "Unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="muted small">
            Totals include all stored records. Limits are checked before prompts; calls already in flight can overshoot.
            Token totals do not imply a subscription price or dollar cost.
          </p>
        </>
      )}
    </section>
  );
}
