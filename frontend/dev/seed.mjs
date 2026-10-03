// Seed a running demo server (dev/demo.sh) with conversations, a thread, and tasks.
//   bun dev/seed.mjs [http://127.0.0.1:7474]   (or: node dev/seed.mjs [http://127.0.0.1:7474])
const base = (process.argv[2] ?? "http://127.0.0.1:7474") + "/api/v1";

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const turn = (target, message) => call("POST", "/turns", { target, message });

await turn({ type: "main" }, "Morning all. Today: ship order validation and tidy up the runtime rotation docs.");
await turn({ type: "group", id: "development" }, "How should we add validation to POST /orders?");
await turn({ type: "group", id: "development" }, "What should an empty body return?");
await turn({ type: "solo", id: "Engineer" }, "Can you sketch the handler before the review?");

const { messages } = await call("GET", "/rooms/group-development/messages");
const anchor = messages.find((m) => m.speaker === "Reviewer");
const { thread } = await call("POST", "/rooms/group-development/threads", {
  anchor_message_id: anchor.id,
  name: "Sanitized error path",
});
await turn({ type: "thread", id: thread.id }, "Which errors count as internal here?");

await call("POST", "/tasks", {
  objective: "Add order validation",
  acceptance: ["Empty body returns 400", "Errors render inline in the form"],
  plan: {
    tasks: [
      { key: "api", objective: "Validate POST /orders input", acceptance: ["400 on empty body"], capabilities: ["backend"], contract: "POST /orders -> 201 {id}; 400 {error}" },
      { key: "ui", objective: "Show validation errors in the order form", acceptance: ["errors render inline"], capabilities: ["frontend"], depends_on: ["api"] },
    ],
  },
});
await call("POST", "/tasks", {
  objective: "Document runtime rotation reasons",
  acceptance: ["Every end_reason value is described"],
});

// Rotate one live session so the sessions view shows an ended epoch.
const { sessions } = await call("GET", "/rooms/group-development/runtime-sessions");
const open = sessions.find((s) => s.ended_at === null);
if (open) await call("POST", "/runtime/rotate", { agent_instance_id: open.agent_instance_id });
await turn({ type: "group", id: "development" }, "Thanks both, let's go with 400 and the standard error shape.");
console.log("seeded");
