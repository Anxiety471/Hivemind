// The sample that arrived as prose: two declarations and the render call that drew them, with
// the JSX its column renderers held, all unfenced.
export const CODE_BLOCK_SAMPLE = `Here is where everything runs:

const data = [
  { key: "1", location: "/home/rakazo (my container)", use: "Edits, tests, shellcheck/ruff, diff reads", state: "wake CLI ready; clones at wake232, wake239, wake241, w246r, t350", limit: "no bun/node build" },
  { key: "2", location: "Orca (code.bocchi.trade, host hitori)", use: "Coding agents, real builds, worktrees", state: "hivemind-main idle (stale 'working'); 4 hivemind worktrees registered", limit: "no terminal live now" },
];

const columns = [
  { title: "Where", dataIndex: "location", width: 260 },
  { title: "What I do there", dataIndex: "use", width: 300 },
  { title: "Verified state now", dataIndex: "state", render: (v) => <Tag>{v}</Tag> },
  { title: "Limit", dataIndex: "limit", render: (v) => <Tag>{v}</Tag> },
];

ReactDOM.render(<Table columns={columns} dataSource={data} />, mountNode);`;

export const CODE_BLOCK_SAMPLE_CODE = CODE_BLOCK_SAMPLE.slice(CODE_BLOCK_SAMPLE.indexOf("const"));
