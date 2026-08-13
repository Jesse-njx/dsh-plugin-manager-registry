import { cacheLoad, cacheSave } from './cache.ts'
import { normalizeRepoUrl } from './awesome.ts'
import type { DiscoveredEntry, RegistryClientDeps, SourceResult } from './types/index.ts'

const CACHE_KEY = 'github'
const SEARCH_QUERY = 'topic:dsh-plugin archived:false'
const GH_JQ = '.items[] | {full_name, html_url, stargazers_count, pushed_at, description}'

/** A raw GitHub search hit, shared by the gh CLI and https API paths. */
export interface RawGithubEntry {
  name: string
  repoUrl: string
  stars: number
  updatedAt: string
  description: string
}

/** Parse one GitHub search item (gh --jq or api.github.com shapes). */
function ghItemToRaw(item: unknown): RawGithubEntry | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  const full = typeof o.full_name === 'string' ? o.full_name : ''
  if (!full) return null
  const repoUrl = typeof o.html_url === 'string' ? o.html_url : `https://github.com/${full}`
  const stars = typeof o.stargazers_count === 'number' ? o.stargazers_count : 0
  const updatedAt = typeof o.pushed_at === 'string' ? o.pushed_at : (typeof o.updated_at === 'string' ? o.updated_at : '')
  const description = typeof o.description === 'string' ? o.description : ''
  return {
    name: full.split('/').pop() ?? full,
    repoUrl: normalizeRepoUrl(repoUrl),
    stars,
    updatedAt,
    description,
  }
}

/**
 * Parse `gh api --paginate --jq` output: newline-delimited JSON objects (one
 * per page item), or a single JSON array for non-paginated responses. Bad
 * lines are skipped, never thrown.
 */
export function parseGhItems(stdout: string): RawGithubEntry[] {
  const out: RawGithubEntry[] = []
  const trimmed = stdout.trim()
  if (!trimmed) return out
  const lines = trimmed.split(/\r?\n/)
  if (lines[0]!.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const raw = ghItemToRaw(item)
          if (raw) out.push(raw)
        }
      }
    } catch {
      /* malformed payload → zero entries */
    }
    return out
  }
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const raw = ghItemToRaw(JSON.parse(line))
      if (raw) out.push(raw)
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/** Parse the api.github.com `/search/repositories` JSON document. */
export function parseGithubApiJson(text: string): RawGithubEntry[] {
  try {
    const parsed = JSON.parse(text) as { items?: unknown[] }
    if (!Array.isArray(parsed.items)) return []
    const out: RawGithubEntry[] = []
    for (const item of parsed.items) {
      const raw = ghItemToRaw(item)
      if (raw) out.push(raw)
    }
    return out
  } catch {
    return []
  }
}

/** Map raw GitHub hits onto the internal merge shape. */
export function githubEntriesToDiscovered(entries: RawGithubEntry[]): DiscoveredEntry[] {
  return entries.map((e) => ({
    name: e.name,
    repoUrl: e.repoUrl,
    description: e.description,
    category: '',
    stars: e.stars,
    updatedAt: e.updatedAt,
    source: ['github'],
  }))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Source 2 — GitHub repo search for the `dsh-plugin` topic. Tries the `gh`
 * CLI first; if gh is absent or unauthenticated, falls back to a plain https
 * call to api.github.com; if both fail, serves the local cache; if there is
 * no cache either, degrades to [] plus a warning. Never rejects, and emits at
 * most ONE warning per source ("one per degraded/skipped source").
 */
export async function fetchGithub(deps: RegistryClientDeps): Promise<SourceResult> {
  let items: RawGithubEntry[] | null = null
  let via: 'gh' | 'https' | 'cache' | null = null
  const failures: string[] = []

  try {
    const res = await deps.gh([
      'api',
      `search/repositories?q=${encodeURIComponent(SEARCH_QUERY)}&per_page=100`,
      '--jq',
      GH_JQ,
    ])
    if (res.missing) {
      failures.push("'gh' CLI not found")
    } else {
      // Parse stdout even on a non-zero exit: gh can emit useful results
      // while still failing on a warning-level error. Only a truly failed
      // call (non-zero AND no parseable output) triggers the https fallback.
      const parsed = parseGhItems(res.stdout)
      if (res.code !== 0 && parsed.length === 0) {
        failures.push(`'gh api' failed (exit ${res.code})`)
      } else {
        items = parsed
        via = 'gh'
        if (res.code !== 0) failures.push(`'gh api' exited ${res.code}; using its output`)
      }
    }
  } catch (err) {
    failures.push(`'gh api' errored (${errorMessage(err)})`)
  }

  if (!items) {
    try {
      const url = `https://api.github.com/search/repositories?${new URLSearchParams({ q: SEARCH_QUERY, per_page: '100' })}`
      const text = await deps.fetchText(url, { headers: { Accept: 'application/vnd.github+json' } })
      items = parseGithubApiJson(text)
      via = 'https'
    } catch (err) {
      failures.push(`https search failed (${errorMessage(err)})`)
    }
  }

  const warnings: string[] = []
  if (items) {
    if (failures.length > 0) {
      const suffix = via === 'https' ? '; results from https search' : ''
      warnings.push(`github: ${failures.join('; ')}${suffix}`)
    }
    if (deps.cacheDir) await cacheSave(deps.cacheDir, CACHE_KEY, items)
  } else {
    const cached = deps.cacheDir ? await cacheLoad<RawGithubEntry[]>(deps.cacheDir, CACHE_KEY) : null
    if (cached) {
      items = cached.data
      warnings.push(`github: ${failures.join('; ')}; using cached results from ${cached.savedAt}`)
    } else {
      warnings.push(`github: ${failures.join('; ')}; no cache available — 0 results`)
    }
  }

  return { entries: githubEntriesToDiscovered(items ?? []), warnings }
}
