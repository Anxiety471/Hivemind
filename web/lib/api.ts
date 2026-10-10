import type { Config, ConfigResponse, DirectoriesResponse, ProjectsResponse, Run } from './types'

/** `unreachable` is true when the API could not be contacted (network error or proxy failure). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly unreachable = false) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.unreachable
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: init?.body === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
    })
  } catch (error) {
    throw new ApiError(`Cannot reach the Hivemind API (${errorMessage(error)})`, 0, true)
  }
  const text = await response.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  const apiMessage = typeof (body as { error?: unknown } | undefined)?.error === 'string'
    ? (body as { error: string }).error : undefined
  if (!response.ok) {
    // A 5xx without our `{error}` envelope comes from the Next proxy failing to reach the API.
    const proxyFailure = apiMessage === undefined && response.status >= 500
    throw new ApiError(
      proxyFailure ? 'Cannot reach the Hivemind API (is the server running?)' : apiMessage ?? `Request failed (${response.status})`,
      response.status, proxyFailure || (apiMessage?.startsWith('API unreachable') ?? false))
  }
  if (body === undefined) throw new ApiError(`Empty response from ${path}`, response.status)
  return body as T
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const api = {
  health: () => request<{ ok: true }>('/api/health'),
  getConfig: () => request<ConfigResponse>('/api/config'),
  saveConfig: (config: Config) => request<ConfigResponse>('/api/config', json('PUT', { config })),
  getProjects: () => request<ProjectsResponse>('/api/projects'),
  setProject: (path: string) => request<ProjectsResponse>('/api/project', json('PUT', { path })),
  listDirectories: (path?: string) =>
    request<DirectoriesResponse>(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  startRun: (task: string) => request<Run>('/api/runs', json('POST', { task })),
  listRuns: () => request<{ runs: Run[] }>('/api/runs').then(r => r.runs),
  getRun: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  eventsUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/events`,
}
