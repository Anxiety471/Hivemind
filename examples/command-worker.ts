// Runnable protocol example, not a real coding agent. Replace with a CLI/SDK wrapper.
import { z } from 'zod'
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const request = z.object({ task: z.string(), instructions: z.string(), artifact: z.string(), feedback: z.string() })
  .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
console.log(`Command harness example for: ${request.task}\nInstructions: ${request.instructions}\nFeedback: ${request.feedback}`)
