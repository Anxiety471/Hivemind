import { z } from 'zod'

export const stageTaskSchema = z.object({
  agent: z.string().min(1),
  role: z.enum(['researcher', 'planner', 'designer', 'worker']).optional(),
  instructions: z.string().min(1),
  reason: z.string().optional(),
}).passthrough()

export const stagePlanSchema = z.object({
  stage: z.enum(['research', 'plan', 'design', 'work']),
  tasks: z.array(stageTaskSchema).min(1).max(16),
  reason: z.string().optional(),
}).passthrough()

export const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('work'), agent: z.string().min(1), instructions: z.string().min(1), reason: z.string().min(1) }).passthrough(),
  z.object({ action: z.literal('dispatch'), stages: z.array(stagePlanSchema).min(1).max(4), parallelPreparation: z.boolean().optional(), reason: z.string().min(1) }).passthrough(),
  z.object({ action: z.literal('finish'), reason: z.string().min(1) }).passthrough(),
  z.object({ action: z.literal('block'), reason: z.string().min(1) }).passthrough(),
])
export const reviewSchema = z.object({ verdict: z.enum(['approved', 'revise', 'blocked']), feedback: z.string().min(1) }).strict()
export type StageTask = z.infer<typeof stageTaskSchema>
export type StagePlan = z.infer<typeof stagePlanSchema>
export type Decision = z.infer<typeof decisionSchema>
export type Review = z.infer<typeof reviewSchema>
export const roles = ['worker', 'reviewer', 'security-reviewer', 'orchestrator', 'router', 'planner', 'designer', 'researcher'] as const
export type Role = typeof roles[number]
export interface Agent { id: string; role: Role; harness: string; model?: string; description: string }
export interface Message { from: string; to: string; kind: 'assignment' | 'result' | 'question' | 'blocked' | 'review'; content: string; attempt: number }
export interface HarnessRequest { agent: Agent; task: string; instructions: string; artifact: string; feedback: string; attempt: number; messages?: Message[] }
export const orchestrationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dispatch'), stages: z.array(stagePlanSchema).min(1).max(4), parallelPreparation: z.boolean().optional(),
    spawn: z.array(z.object({ id: z.string().min(1), template: z.string().min(1), description: z.string().min(1) }).strict()).max(16).default([]),
    reason: z.string().min(1) }).strict(),
  z.object({ action: z.literal('review'), reason: z.string().min(1) }).strict(),
  z.object({ action: z.literal('block'), reason: z.string().min(1) }).strict(),
])
export type Orchestration = z.infer<typeof orchestrationSchema>
export const workerReplySchema = z.object({ status: z.enum(['completed', 'question', 'blocked']), artifact: z.string().default(''), message: z.string().min(1) }).strict()
export interface ReviewResult extends Review { agent: string; role: 'reviewer' | 'security-reviewer'; attempt: number }

export interface Harness { run(request: HarnessRequest, signal: AbortSignal): Promise<string> }
export interface Event { node: string; attempt: number; message: string }
export interface RunState {
  task: string; artifact: string; feedback: string; attempts: number;
  status: 'running' | 'completed' | 'blocked' | 'exhausted';
  approved: boolean; decision: Decision | null; events: Event[]
  messages?: Message[]; reviews?: ReviewResult[]; spawnedAgents?: Agent[]; readyForReview?: boolean; orchestration?: Orchestration | null; workerArtifacts?: Record<string, string>; pendingWorkers?: string[]
}
export interface RouterContext extends RunState { agents: Agent[] }
export interface Router { decide(context: RouterContext, signal: AbortSignal): Promise<Decision> }
export function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
}
