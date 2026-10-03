// Slash commands typed into a composer. Pure functions so they run under `bun test` or `node --test`.
// Skills are listed as `/skill:<name>`, the same way OMP offers them.

export type SlashCommand = { name: string; usage: string; summary: string };

export const COMMANDS: SlashCommand[] = [
  { name: "help", usage: "/help", summary: "List the slash commands" },
  { name: "skills", usage: "/skills", summary: "List the skills agents can use" },
  { name: "tools", usage: "/tools", summary: "List the tools agents can call" },
  { name: "queue", usage: "/queue <message>", summary: "Queue a turn instead of steering the active reply" },
];

export const SKILL_PREFIX = "skill:";

type SkillLike = { name: string; description: string; argument_hint?: string };

export type Slash =
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; args: string };

/** `//text` sends `/text` as an ordinary message; anything not starting with `/` is a message. */
export function parseSlash(input: string): Slash {
  const text = input.trim();
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) };
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: "message", text };
  return { kind: "command", name: match[1], args: match[2].trim() };
}

export type Completion = { label: string; detail: string; insert: string };

const MAX_SKILL_ROWS = 50;

/** Menu entries while the command name is being typed: commands first, then `/skill:<name>` rows. */
export function completions(input: string, skills: SkillLike[]): Completion[] {
  const typed = /^\/(\S*)$/.exec(input);
  if (!typed) return [];
  const query = typed[1].toLowerCase();
  const commands = COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => ({
    label: c.usage,
    detail: c.summary,
    insert: `/${c.name}`,
  }));
  const rows = skills
    .filter((s) => `${SKILL_PREFIX}${s.name}`.toLowerCase().includes(query))
    .slice(0, MAX_SKILL_ROWS)
    .map((s) => ({
      label: `/${SKILL_PREFIX}${s.name}`,
      detail: s.description,
      insert: `/${SKILL_PREFIX}${s.name} `,
    }));
  return [...commands, ...rows];
}

/** The message the agents receive for `/skill:<name> [request]`. */
export function skillPrompt(name: string, request: string): string {
  const lead = `Use the "${name}" skill: call skills.read for it first, then follow its instructions.`;
  return request ? `${lead}\n\n${request}` : lead;
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => `- \`${c.usage}\` — ${c.summary}`).join("\n");
  return `**Slash commands**\n\n${rows}\n- \`/${SKILL_PREFIX}<name> [request]\` — ask the agents to use a skill (\`/skills\` lists them)\n- \`//text\` — send a message that starts with a slash`;
}

export function skillsText(skills: SkillLike[], dirs: string[]): string {
  if (skills.length === 0) {
    return dirs.length === 0
      ? "No skills are configured. Add `[skills]` with `dirs = [\"~/.agents/skills\"]` to `hivemind.toml` and restart."
      : `No skills found in ${dirs.map((d) => `\`${d}\``).join(", ")}. Each skill is a folder containing \`SKILL.md\`.`;
  }
  const rows = skills.map((s) => {
    const hint = s.argument_hint ? ` \`${s.argument_hint}\`` : "";
    const text = s.description.length > 140 ? `${s.description.slice(0, 140)}…` : s.description;
    return `- **/${SKILL_PREFIX}${s.name}**${hint} — ${text}`;
  });
  return `**Skills** (${skills.length}) — run one with \`/${SKILL_PREFIX}<name> [request]\`\n\n${rows.join("\n")}`;
}

export function toolsText(namespaces: Record<string, string[]>): string {
  const rows = Object.entries(namespaces).map(([ns, tools]) => `- **${ns}** — ${tools.map((t) => `\`${t}\``).join(", ")}`);
  return `**Tools agents can call** — which ones a persona is offered depends on its room, roles and task.\n\n${rows.join("\n")}`;
}
