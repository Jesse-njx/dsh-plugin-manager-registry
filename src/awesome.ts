import type { PmConfig, PluginSource } from '@dsh-pm/core'
import { cacheLoad, cacheSave } from './cache.ts'
import type { DiscoveredEntry, RegistryClientDeps, SourceResult } from './types/index.ts'

const CACHE_KEY = 'awesome'

/** A parsed awesome-list row: a markdown link under a category heading. */
export interface RawAwesomeEntry {
  name: string
  url: string
  description: string
  category: string
}

/**
 * Tolerant awesome-dsh-plugin README parser. Skips — never throws — on any
 * row it cannot interpret, counting the skips so the caller can warn.
 *
 * Recognized shape (both `-` and `*` bullets):
 *   `- [name](https://github.com/owner/repo) — description`
 *   `- [name](url) - description`
 *
 * Everything else (paragraphs, tables, nested bullets, bare text) is ignored.
 * `#` headings become the running category for subsequent entries.
 */
export function parseAwesomeReadme(markdown: string): { entries: RawAwesomeEntry[]; skipped: number } {
  const entries: RawAwesomeEntry[] = []
  let category = ''
  let skipped = 0
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      category = trimmed.replace(/^#+\s*/, '').trim()
      continue
    }
    if (!/^[-*]\s+/.test(trimmed)) continue
    const m = /^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*[-–—:]\s*(.*))?$/.exec(trimmed)
    if (!m) {
      skipped++
      continue
    }
    const name = m[1]!.trim()
    const url = m[2]!.trim()
    const description = (m[3] ?? '').trim()
    if (!name || !/^https?:\/\//.test(url)) {
      skipped++
      continue
    }
    entries.push({ name, url, description, category })
  }
  return { entries, skipped }
}

/**
 * Classify the discovery source an awesome-list URL contributes as. The
 * `PluginSource` union has no 'awesome' member, so entries are mapped by what
 * their URL points at: GitHub repos → 'github', npm pages → 'npm'.
 */
export function classifyAwesomeSource(url: string): PluginSource {
  if (/npmjs\.(com|org)\//.test(url)) return 'npm'
  return 'github'
}

/** Normalize a repo reference to a canonical https URL (dedupe key #1). */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim()
  if (!u) return u
  // npm's links.repository often carries transport prefixes; strip them all
  // down to a plain https URL so dedupe keys agree across sources.
  u = u.replace(/^git\+/, '')
  u = u.replace(/^git:\/\//, 'https://')
  u = u.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
  u = u.replace(/^git@github\.com:/, 'github.com/')
  if (!/^https?:\/\//.test(u)) u = `https://${u}`
  u = u.replace(/\.git$/, '').replace(/\/+$/, '')
  return u
}

/** Map parsed awesome rows onto the internal merge shape. */
export function awesomeEntriesToDiscovered(entries: RawAwesomeEntry[]): DiscoveredEntry[] {
  return entries.map((e) => ({
    name: e.name,
    repoUrl: normalizeRepoUrl(e.url),
    description: e.description,
    category: e.category,
    source: [classifyAwesomeSource(e.url)],
  }))
}

/**
 * Source 1 — awesome-dsh-plugin README. Fetches the raw markdown, parses it,
 * caches the raw markdown on success, and falls back to the cache when the
 * fetch fails (offline). A fully dead source degrades to [] plus a warning;
 * the caller never sees a rejection.
 */
export async function fetchAwesome(cfg: PmConfig['registry'], deps: RegistryClientDeps): Promise<SourceResult> {
  const warnings: string[] = []
  let markdown: string | null = null
  try {
    markdown = await deps.fetchText(cfg.awesomeUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const cached = deps.cacheDir ? await cacheLoad<string>(deps.cacheDir, CACHE_KEY) : null
    if (cached) {
      markdown = cached.data
      warnings.push(`awesome: fetch failed (${msg}); using cached list from ${cached.savedAt}`)
    } else {
      warnings.push(`awesome: fetch failed (${msg}) and no cache available; 0 entries`)
      return { entries: [], warnings }
    }
  }
  const { entries, skipped } = parseAwesomeReadme(markdown)
  if (skipped > 0) warnings.push(`awesome: skipped ${skipped} unparseable row(s)`)
  if (deps.cacheDir) await cacheSave(deps.cacheDir, CACHE_KEY, markdown)
  return { entries: awesomeEntriesToDiscovered(entries), warnings }
}
