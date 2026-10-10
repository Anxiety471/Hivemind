import type { NextConfig } from 'next'

const api = (process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '')

const config: NextConfig = {
  // Gzip buffering would stall Server-Sent Events; the API is local anyway.
  compress: false,
  reactStrictMode: true,
  // Harness installs can run for up to 5 minutes (API-side timeout); the default 30s proxy timeout would cut them off.
  experimental: { proxyTimeout: 330_000 },
  // `/api/runs/:id/events` is served by an explicit streaming route handler (app/api/runs/[id]/events),
  // which takes precedence over this rewrite; everything else is proxied verbatim.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }]
  },
}

export default config
