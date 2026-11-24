import path from "node:path";

/** A pull-through cache for one deployment; every value comes from the operator's environment. */
export interface MirrorConfig {
  /** Directory holding cached artifacts, temporary downloads and the PyPI file index. */
  dataDir: string;
  /** The URL package managers use, so rewritten index links point back at this mirror. */
  publicUrl: string;
  host: string;
  port: number;
  /** Total bytes kept on disk; the least recently used artifacts are evicted first. */
  maxBytes: number;
  /** How long packuments and simple indexes stay fresh before a background refetch. */
  indexTtlMs: number;
  upstreamTimeoutMs: number;
  maxConcurrentFetches: number;
  npmUpstream: string;
  goUpstream: string;
  pypiUpstream: string;
  pypiFilesUpstream: string;
}

/** Packuments and indexes change often; five minutes keeps installs current without hammering upstreams. */
export const MIRROR_INDEX_TTL_MS = 5 * 60_000;
export const MIRROR_UPSTREAM_TIMEOUT_MS = 30_000;
export const MIRROR_MAX_CONCURRENT_FETCHES = 8;
const DEFAULT_MAX_GB = 20;
const DEFAULT_PORT = 8099;
const DEFAULT_HOST = "127.0.0.1";

// The only hosts the mirror talks to, one per ecosystem. Operator overrides exist for testing a
// private registry or a local fake; a request can never move them.
const NPM_UPSTREAM = "https://registry.npmjs.org";
const GO_UPSTREAM = "https://proxy.golang.org";
const PYPI_UPSTREAM = "https://pypi.org";
const PYPI_FILES_UPSTREAM = "https://files.pythonhosted.org";

export function mirrorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MirrorConfig {
  const publicUrl = baseUrl(env.PACKAGE_MIRROR_PUBLIC_URL, "PACKAGE_MIRROR_PUBLIC_URL");
  return {
    dataDir: path.resolve(env.PACKAGE_MIRROR_DATA_DIR?.trim() || "./data/package-mirror"),
    publicUrl,
    host: env.PACKAGE_MIRROR_HOST?.trim() || DEFAULT_HOST,
    port: port(env.PACKAGE_MIRROR_PORT),
    maxBytes: maxBytes(env.PACKAGE_MIRROR_MAX_GB),
    indexTtlMs: MIRROR_INDEX_TTL_MS,
    upstreamTimeoutMs: MIRROR_UPSTREAM_TIMEOUT_MS,
    maxConcurrentFetches: MIRROR_MAX_CONCURRENT_FETCHES,
    npmUpstream: baseUrl(
      env.PACKAGE_MIRROR_NPM_UPSTREAM,
      "PACKAGE_MIRROR_NPM_UPSTREAM",
      NPM_UPSTREAM,
    ),
    goUpstream: baseUrl(env.PACKAGE_MIRROR_GO_UPSTREAM, "PACKAGE_MIRROR_GO_UPSTREAM", GO_UPSTREAM),
    pypiUpstream: baseUrl(
      env.PACKAGE_MIRROR_PYPI_UPSTREAM,
      "PACKAGE_MIRROR_PYPI_UPSTREAM",
      PYPI_UPSTREAM,
    ),
    pypiFilesUpstream: baseUrl(
      env.PACKAGE_MIRROR_PYPI_FILES_UPSTREAM,
      "PACKAGE_MIRROR_PYPI_FILES_UPSTREAM",
      PYPI_FILES_UPSTREAM,
    ),
  };
}

/** One allowlist per ecosystem, so a redirect can only reach that ecosystem's own hosts. */
export function mirrorHostAllowlists(config: MirrorConfig): {
  npm: ReadonlySet<string>;
  go: ReadonlySet<string>;
  pypi: ReadonlySet<string>;
  pypiFiles: ReadonlySet<string>;
} {
  return {
    npm: new Set([new URL(config.npmUpstream).host]),
    // Go redirects module zips to its object store.
    go: new Set([new URL(config.goUpstream).host, "storage.googleapis.com"]),
    pypi: new Set([new URL(config.pypiUpstream).host]),
    pypiFiles: new Set([new URL(config.pypiFilesUpstream).host]),
  };
}

function baseUrl(value: string | undefined, name: string, fallback?: string): string {
  const raw = value?.trim() || fallback;
  if (!raw) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${name} must be an http or https URL`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must not carry credentials, a query or a fragment`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function port(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error("PACKAGE_MIRROR_PORT must be a TCP port");
  return parsed;
}

function maxBytes(value: string | undefined): number {
  const raw = value?.trim();
  const gigabytes = raw ? Number(raw) : DEFAULT_MAX_GB;
  if (!Number.isFinite(gigabytes) || gigabytes <= 0)
    throw new Error("PACKAGE_MIRROR_MAX_GB must be a positive number");
  const bytes = Math.floor(gigabytes * 1024 ** 3);
  if (bytes < 1) throw new Error("PACKAGE_MIRROR_MAX_GB is too small");
  return bytes;
}
