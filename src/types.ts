import { z } from 'zod'

export const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('work'), agent: z.string().min(1), instructions: z.string().min(1), reason: z.string().min(1) }).strict(),
  z.object({ action: z.literal('finish'), reason: z.string().min(1) }).strict(),
  z.object({ action: z.literal('block'), reason: z.string().min(1) }).strict(),
])
export const reviewSchema = z.object({ verdict: z.enum(['approved', 'revise', 'blocked']), feedback: z.string().min(1) }).strict()
export type Decision = z.infer<typeof decisionSchema>
export type Review = z.infer<typeof reviewSchema>
export type Role = 'worker' | 'reviewer' | 'router'
export interface Agent { id: string; role: Role; harness: string; description: string }
export interface HarnessRequest { agent: Agent; task: string; instructions: string; artifact: string; feedback: string; attempt: number }
export interface Harness { run(request: HarnessRequest, signal: AbortSignal): Promise<string> }
export interface Event { node: string; attempt: number; message: string }
export interface RunState {
  task: string; artifact: string; feedback: string; attempts: number;
  status: 'running' | 'completed' | 'blocked' | 'exhausted';
  approved: boolean; decision: Decision | null; events: Event[]
}
export interface RouterContext extends RunState { agents: Agent[] }
export interface Router { decide(context: RouterContext, signal: AbortSignal): Promise<Decision> }
export function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
}
