import stringWidth from 'string-width'
import type { z } from 'zod'
import { configSchema } from './config.js'
export type Config = z.infer<typeof configSchema>

export function selectWorker(config: Config, workerId: string, harnessId: string): Config {
  if (!config.agents.some(agent => agent.id === workerId && agent.role === 'worker')) throw new Error('Unknown worker')
  if (!config.harnesses[harnessId]) throw new Error('Unknown harness')
  return { ...config, agents: config.agents.filter(agent => agent.role !== 'worker' || agent.id === workerId)
    .map(agent => agent.id === workerId ? { ...agent, harness: harnessId } : agent) }
}
// Strip terminal control sequences from model responses and pasted task input.
export function safeText(text: string): string {
  return text.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
export function pageLines(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return safeText(text).split('\n').flatMap(line => {
    if (!line) return ['']
    const result: string[] = []
    let buffer = ''
    for (const { segment } of segmenter.segment(line)) {
      if (buffer && stringWidth(buffer + segment) > limit) {
        const space = buffer.lastIndexOf(' ')
        if (space > 0) {
          result.push(buffer.slice(0, space))
          buffer = buffer.slice(space + 1)
          // A long unbroken remainder may still need its own line.
          if (stringWidth(buffer + segment) > limit) { result.push(buffer); buffer = '' }
        } else { result.push(buffer); buffer = '' }
      }
      buffer += segment
    }
    result.push(buffer)
    return result
  })
}
