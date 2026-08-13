import type { RegistryEntry, RegistryResult } from '@dsh-pm/core'
import { normalizeRepoUrl } from './awesome.ts'
import type { DiscoveredEntry, SourceResult } from './types/index.ts'

/**
 * Merge the three discovery sources into one deduped set. Dedupe happens in
 * two passes, per the spec: first by normalized repo URL, then by bare name.
 * When two entries collapse, metadata is unioned (npmName, repoUrl, stars,
 * category, …) and `source` accumulates distinct contributors — so a GitHub
 * hit and an npm hit for the same project become one RegistryEntry carrying
 * both `repoUrl` and `npmName`.
 *
 * The name pass only folds in entries that have NO repo identity (npm-only
 * hits without a repository link): two distinct repos that happen to share a
 * bare name are different projects and stay separate.
 */
export function mergeSources(results: SourceResult[]): RegistryResult {
  const warnings = results.flatMap((r) => r.warnings)
  const byRepo = new Map<string, RegistryEntry>()
  const withoutRepo: RegistryEntry[] = []

  for (const result of results) {
    for (const d of result.entries) {
      const entry = toEntry(d)
      if (entry.repoUrl) {
        const key = normalizeRepoUrl(entry.repoUrl)
        const existing = byRepo.get(key)
        if (existing) mergeInto(existing, entry)
        else byRepo.set(key, { ...entry, repoUrl: key })
      } else {
        withoutRepo.push(entry)
      }
    }
  }

  // Second pass: fold repo-less entries into the repo-deduped set by bare
  // name. Only entries without a repo identity collapse by name.
  const named = new Map<string, RegistryEntry>()
  for (const entry of withoutRepo) {
    const existing = named.get(entry.name)
    if (existing) mergeInto(existing, entry)
    else named.set(entry.name, entry)
  }
  const merged = [...byRepo.values()]
  for (const entry of named.values()) {
    const host = merged.find((e) => e.name === entry.name)
    if (host) mergeInto(host, entry)
    else merged.push(entry)
  }

  return { entries: merged, warnings }
}

function toEntry(d: DiscoveredEntry): RegistryEntry {
  return {
    name: d.name,
    description: d.description ?? '',
    category: d.category ?? '',
    source: [...d.source],
    ...(d.repoUrl ? { repoUrl: d.repoUrl } : {}),
    ...(d.npmName ? { npmName: d.npmName } : {}),
    ...(typeof d.stars === 'number' ? { stars: d.stars } : {}),
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
  }
}

/** Fill `target`'s gaps from `extra`; the richer entry wins, sources union. */
export function mergeInto(target: RegistryEntry, extra: RegistryEntry): void {
  if (!target.repoUrl && extra.repoUrl) target.repoUrl = extra.repoUrl
  if (!target.npmName && extra.npmName) target.npmName = extra.npmName
  if (!target.description && extra.description) target.description = extra.description
  if (!target.category && extra.category) target.category = extra.category
  if (target.stars === undefined && extra.stars !== undefined) target.stars = extra.stars
  if (!target.updatedAt && extra.updatedAt) target.updatedAt = extra.updatedAt
  for (const s of extra.source) {
    if (!target.source.includes(s)) target.source.push(s)
  }
}

/**
 * Filter by substring over name / npmName / description / category, then sort
 * by `stars ?? 0` descending with name as the tiebreak. An empty query
 * returns everything, sorted.
 */
export function searchEntries(entries: RegistryEntry[], q: string): RegistryEntry[] {
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          (e.npmName ?? '').toLowerCase().includes(needle) ||
          e.description.toLowerCase().includes(needle) ||
          e.category.toLowerCase().includes(needle),
      )
    : entries
  return [...filtered].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name))
}
