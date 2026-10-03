import { useState } from "react";
import { api, type OpenQuestion, type Task } from "../api";
import { ErrorNote, useAction } from "../ui";

export function TaskInput({
  task,
  questions = [],
  onDone,
}: {
  task: Task;
  questions?: OpenQuestion[];
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [steer, setSteer] = useState("");
  const [delivery, setDelivery] = useState<string | null>(null);
  const action = useAction();
  const needsAnswer = questions.length > 0 || task.status === "needs_input";
  return (
    <>
      {needsAnswer && (
        <div className="card form">
          <h3>Input needed</h3>
          {questions.map((q) => (
            <p key={q.attempt_id}>
              <strong>{q.persona} asks:</strong> {q.question}
              {q.to && <span className="muted"> · addressed to {q.to}</span>}
            </p>
          ))}
          <label>
            Answer
            <textarea value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!answer.trim() || action.busy}
            onClick={() =>
              action.run(async () => {
                await api.taskInput(task.id, answer.trim());
                setAnswer("");
                onDone();
              })
            }
          >
            Send answer
          </button>
        </div>
      )}
      {(task.status === "running" || task.status === "planning" || task.status === "review") && (
        <div className="card form">
          <h3>Steer this attempt</h3>
          <label>
            Guidance
            <textarea value={steer} maxLength={4000} onChange={(e) => setSteer(e.target.value)} />
          </label>
          <button
            disabled={!steer.trim() || action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await api.taskSteer(task.id, steer.trim());
                setDelivery(
                  result.steer.delivered_to.length
                    ? `Queued to live sessions: ${result.steer.delivered_to.join(", ")}.`
                    : "Saved as feedback; no live session accepted delivery.",
                );
                setSteer("");
                onDone();
              })
            }
          >
            Send guidance
          </button>
          {delivery && <p role="status">{delivery}</p>}
        </div>
      )}
      <ErrorNote error={action.error} />
    </>
  );
}
