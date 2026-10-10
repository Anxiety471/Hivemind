import type { AgentConfig, Config, Role } from '@/lib/types'

export const ROLE_HELP: Record<Role, string> = {
  worker: 'Does the work and produces the artifact. At least one is required. With the rule router the first worker always runs; with the model router the router agent picks among workers.',
  orchestrator: 'Selects and spawns run-scoped workers after routing; receives results and questions and directs revisions. Added from the first worker when missing.',
  'security-reviewer': 'Independently checks security. Both reviewers must approve the same artifact. Added from the general reviewer when missing.',
  reviewer: 'Reviews each artifact and answers approved, revise or blocked; completion requires its approval and security-reviewer approval. Exactly one is required.',
  router: 'Optional. Only used when Loop → Router is "model": it decides whether to work, finish or block. Ignored with the rule router.',
  planner: 'Optional. Breaks down complex tasks into architectural roadmaps and execution plans for subsequent stages.',
  designer: 'Optional. Defines visual structure, component interfaces, design tokens, and UX specifications.',
  researcher: 'Optional. Investigates codebase context, external APIs, and technical feasibility before planning or implementation.',
}

const GUIDE: [Role, string][] = [
  ['orchestrator', 'spawns workers and coordinates two-way messages and revisions'],
  ['security-reviewer', 'checks security independently; must agree with the general reviewer'],
  ['worker', 'does the work and produces the artifact (at least one)'],
  ['reviewer', 'approves, requests a revision or blocks each artifact (exactly one)'],
  ['router', 'optional; decides work / finish / block, only when Router = model'],
  ['planner', 'optional; breaks down tasks into architectural execution plans'],
  ['designer', 'optional; defines interfaces, UI components, and design specifications'],
  ['researcher', 'optional; explores codebase context and technical feasibility'],
]

export function roleWarnings(agents: AgentConfig[], router: Config['router']): string[] {
  const count = (role: Role) => agents.filter(agent => agent.role === role).length
  const warnings: string[] = []
  const reviewers = count('reviewer')
  if (reviewers !== 1) warnings.push(reviewers === 0 ? 'No reviewer: exactly one reviewer is required.' : `${reviewers} reviewers: exactly one reviewer is required.`)
  if (count('worker') === 0) warnings.push('No worker: at least one worker is required.')
  if (router.type === 'rule' && count('router') > 0) warnings.push('A router agent is present but unused: Router is set to "rule". Switch Router to "model" to use it.')
  if (router.type === 'model' && count('router') === 0) warnings.push('Router is set to "model" but there is no router agent: add an agent with the router role.')
  return warnings
}

export default function RoleGuide({ agents, router }: { agents: AgentConfig[]; router: Config['router'] }) {
  const warnings = roleWarnings(agents, router)
  return (
    <div className="role-guide">
      <ul className="role-guide-list">
        {GUIDE.map(([role, text]) => (
          <li key={role} title={ROLE_HELP[role]}><span className="chip role-chip">{role}</span> <span className="muted small-text">{text}</span></li>
        ))}
      </ul>
      {warnings.map(warning => <p key={warning} className="role-warning" role="alert">{warning}</p>)}
    </div>
  )
}
