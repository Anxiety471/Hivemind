// Streaming proxy for Server-Sent Events: rewrites may buffer, a route handler passes the body through untouched.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const api = (process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '')

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(`${api}/api/runs/${encodeURIComponent(id)}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: request.signal,
      cache: 'no-store',
    })
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ error: `API unreachable: ${message}` }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
