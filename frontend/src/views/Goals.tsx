import { useState } from "react";
import { api } from "../api";
import { Badge, ErrorNote, PageHeader, useAction, useAsync } from "../ui";
export function Goals() {
  const goals = useAsync(api.goals, []);
  const action = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [constraints, setConstraints] = useState("");
  const [criteria, setCriteria] = useState("");
  const lines = (s: string) =>
    s
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <div className="page task-detail">
      <PageHeader title="Project goals" sub="Persistent intent and constraints shared by linked tasks." />
      <ErrorNote error={goals.error} />
      <ErrorNote error={action.error} />
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => {
            await api.createGoal({
              title,
              description,
              workspace,
              constraints: lines(constraints),
              success_criteria: lines(criteria),
            });
            setTitle("");
            setDescription("");
            setCriteria("");
            await goals.reload();
          });
        }}
      >
        <h3>New project goal</h3>
        <label>
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea required maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Project workspace
          <input required value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>
        <label>
          Constraints (one per line)
          <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        </label>
        <label>
          Success criteria (one per line)
          <textarea required value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <button className="primary" disabled={action.busy}>
          Create goal
        </button>
      </form>
      {goals.data?.goals.map((g) => (
        <section className="card" key={g.id}>
          <h3>
            {g.title} <Badge value={g.status} />
          </h3>
          <p>{g.description}</p>
          <p className="mono small">{g.workspace}</p>
          <h4>Constraints</h4>
          <ul>
            {g.constraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <h4>Success criteria</h4>
          <ul>
            {g.success_criteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="row">
            {["active", "achieved", "archived"]
              .filter((s) => s !== g.status)
              .map((status) => (
                <button
                  key={status}
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api.setGoalStatus(g.id, status, g.revision);
                      await goals.reload();
                    })
                  }
                >
                  Mark {status}
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
