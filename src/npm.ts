import type { PmConfig } from '@dsh-pm/core'
import { normalizeRepoUrl } from './awesome.ts'
import { cacheLoad, cacheSave } from './cache.ts'
import type { DiscoveredEntry, RegistryClientDeps, SourceResult } from './types/index.ts'

const CACHE_KEY = 'npm'
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'

/** A raw npm search hit, shared by the `npm search --json` and registry API paths. */
export interface RawNpmEntry {
  name: string
  repoUrl?: string
  description: string
}

function npmItemToRaw(item: unknown): RawNpmEntry | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name : ''
  if (!name) return null
  const links = typeof o.links === 'object' && o.links !== null ? (o.links as Record<string, unknown>) : {}
  const repo = typeof links.repository === 'string' ? links.repository : ''
  const description = typeof o.description === 'string' ? o.description : ''
  return { name, repoUrl: repo ? normalizeRepoUrl(repo) : undefined, description }
}

/** Parse `npm search --json <keyword>` output (a JSON array of package objects). */
export function parseNpmSearchJson(stdout: string): RawNpmEntry[] {
  try {
    const arr = JSON.parse(stdout) as unknown
    if (!Array.isArray(arr)) return []
    const out: RawNpmEntry[] = []
    for (const item of arr) {
      const raw = npmItemToRaw(item)
      if (raw) out.push(raw)
    }
    return out
  } catch {
    return []
  }
}

/** Parse the registry `/-/v1/search` JSON document ({ objects: [{ package }] }). */
export function parseNpmRegistrySearch(text: string): RawNpmEntry[] {
  try {
    const parsed = JSON.parse(text) as { objects?: unknown[] }
    if (!Array.isArray(parsed.objects)) return []
    const out: RawNpmEntry[] = []
    for (const obj of parsed.objects) {
      const pkg = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>).package : undefined
      const raw = npmItemToRaw(pkg)
      if (raw) out.push(raw)
    }
    return out
  } catch {
    return []
  }
}

/** Map raw npm hits onto the internal merge shape (name doubles as npmName). */
export function npmEntriesToDiscovered(entries: RawNpmEntry[]): DiscoveredEntry[] {
  return entries.map((e) => ({
    name: e.name,
    npmName: e.name,
    repoUrl: e.repoUrl,
    description: e.description,
    category: '',
    source: ['npm'],
  }))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Source 3 — npm keyword search (config `npmKeyword`, default `dsh`). Tries
 * `npm search --json` first; falls back to the registry `/-/v1/search` https
 * endpoint; then the local cache; then degrades to [] plus a warning. Never
 * rejects, and emits at most ONE warning per source.
 */
export async function fetchNpm(cfg: PmConfig['registry'], deps: RegistryClientDeps): Promise<SourceResult> {
  let items: RawNpmEntry[] | null = null
  let via: 'cli' | 'registry' | 'cache' | null = null
  const failures: string[] = []

  try {
    const res = await deps.npm(['search', '--json', '--searchlimit=100', cfg.npmKeyword])
    if (res.missing) {
      failures.push("'npm' CLI not found")
    } else {
      // Parse stdout even on a non-zero exit: npm can emit a valid JSON array
      // while still failing on a cache warning (observed: EPERM exit 255).
      // Only a truly failed call (non-zero AND no parseable output) triggers
      // the registry https fallback.
      const parsed = parseNpmSearchJson(res.stdout)
      if (res.code !== 0 && parsed.length === 0) {
        failures.push(`'npm search' failed (exit ${res.code})`)
      } else {
        items = parsed
        via = 'cli'
        if (res.code !== 0) failures.push(`'npm search' exited ${res.code}; using its output`)
      }
    }
  } catch (err) {
    failures.push(`'npm search' errored (${errorMessage(err)})`)
  }

  if (!items) {
    try {
      const url = `${NPM_SEARCH_URL}?${new URLSearchParams({ text: `keywords:${cfg.npmKeyword}`, size: '100' })}`
      const text = await deps.fetchText(url, { headers: { Accept: 'application/json' } })
      items = parseNpmRegistrySearch(text)
      via = 'registry'
    } catch (err) {
      failures.push(`registry search failed (${errorMessage(err)})`)
    }
  }

  const warnings: string[] = []
  if (items) {
    if (failures.length > 0) {
      const suffix = via === 'registry' ? '; results from registry search' : ''
      warnings.push(`npm: ${failures.join('; ')}${suffix}`)
    }
    if (deps.cacheDir) await cacheSave(deps.cacheDir, CACHE_KEY, items)
  } else {
    const cached = deps.cacheDir ? await cacheLoad<RawNpmEntry[]>(deps.cacheDir, CACHE_KEY) : null
    if (cached) {
      items = cached.data
      warnings.push(`npm: ${failures.join('; ')}; using cached results from ${cached.savedAt}`)
    } else {
      warnings.push(`npm: ${failures.join('; ')}; no cache available — 0 results`)
    }
  }

  return { entries: npmEntriesToDiscovered(items ?? []), warnings }
}
