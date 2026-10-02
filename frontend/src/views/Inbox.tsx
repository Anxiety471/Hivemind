import { useEffect } from "react";
import { api } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Badge, Empty, ErrorNote, PageHeader, useAction, useAsync } from "../ui";
import { TaskInput } from "./TaskInput";

export function Inbox() {
  const inbox = useAsync(api.operatorInbox, []);
  const action = useAction();
  useRefreshOn((e) => /^(task|attempt)\./.test(e.type), inbox.reload, [inbox.reload]);
  useEffect(() => {
    const timer = window.setInterval(inbox.reload, 5000);
    return () => clearInterval(timer);
  }, [inbox.reload]);
  return (
    <div className="page task-detail">
      <PageHeader title="Operator inbox" sub="Questions, blockers, failed work, and pending reviews." />
      <ErrorNote error={inbox.error} />
      <ErrorNote error={action.error} />
      {inbox.data?.length === 0 && <Empty>Nothing needs your attention.</Empty>}
      {inbox.data?.map(({ task, questions }) => (
        <section className="card" key={task.id}>
          <h3>
            <a href={href("tasks", task.id)}>{task.objective}</a>
          </h3>
          <p>
            <Badge value={task.status} />{" "}
            <span className="muted">
              {task.owner ?? task.coordinator} · {task.id}
            </span>
          </p>
          {task.status_reason && <p>{task.status_reason}</p>}
          <TaskInput task={task} questions={questions} onDone={inbox.reload} />
          <div className="row">
            <a className="button ghost" href={href("tasks", task.id)}>
              Open task and evidence
            </a>
            {task.status === "blocked" && (
              <button
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.taskAction(task.root_id, "resume", { retry: true });
                    await inbox.reload();
                  })
                }
              >
                Retry blocked work in root task
              </button>
            )}
            {!["completed", "failed", "cancelled"].includes(task.status) && (
              <button
                className="danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.taskAction(task.id, "cancel");
                    await inbox.reload();
                  })
                }
              >
                Cancel task
              </button>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
