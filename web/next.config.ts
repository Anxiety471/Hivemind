import type { NextConfig } from 'next'

const api = (process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '')

const config: NextConfig = {
  // Gzip buffering would stall Server-Sent Events; the API is local anyway.
  compress: false,
  reactStrictMode: true,
  // `/api/runs/:id/events` is served by an explicit streaming route handler (app/api/runs/[id]/events),
  // which takes precedence over this rewrite; everything else is proxied verbatim.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }]
  },
}

export default config
