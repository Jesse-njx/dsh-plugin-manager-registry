import type { PmConfig, RegistryClient, RegistryEntry } from '@dsh-pm/core'
import { fetchAwesome, normalizeRepoUrl } from './awesome.ts'
import { defaultDeps } from './exec.ts'
import { fetchGithub } from './github.ts'
import { mergeSources, searchEntries } from './merge.ts'
import { fetchNpm } from './npm.ts'
import type { RegistryClientDeps } from './types/index.ts'

/**
 * Build a RegistryClient (spec §5.2). Wires the real I/O: global fetch for
 * the awesome README and https API fallbacks, the `gh` CLI for GitHub topic
 * search, and the `npm` CLI for npm keyword search / version lookup.
 *
 * Every source degrades independently: a dead source contributes fewer
 * entries (or cached ones) and a warning, never a rejection. After each
 * `search`, the warnings of the last run are available on the returned
 * client's `lastWarnings` property (a documented v0.1 extra beyond the
 * frozen `RegistryClient` interface, for the CLI to print dimmed).
 */
export function createRegistryClient(cfg: PmConfig['registry']): RegistryClient {
  return createRegistryClientWithDeps(cfg, defaultDeps())
}

/**
 * Injectable variant used by tests and advanced consumers: pass fake
 * `fetchText` / `gh` / `npm` runners and a temp `cacheDir` to exercise the
 * full merge/dedupe/degrade pipeline with zero network or subprocesses.
 */
export function createRegistryClientWithDeps(cfg: PmConfig['registry'], deps: RegistryClientDeps): RegistryClient {
  return new RegistryClientImpl(cfg, deps)
}

/** Convenience one-shot (spec §5.2): `search(q, cfg)` over a fresh client. */
export async function search(q: string, cfg: PmConfig['registry']): Promise<RegistryEntry[]> {
  return createRegistryClient(cfg).search(q)
}

interface NormalizedRef {
  kind: 'repo' | 'name'
  /** Lowercased matching key for name/npmName lookups. */
  base: string
  /** Canonical repo URL when `kind === 'repo'`. */
  repoUrl?: string
  /** Repo basename when `kind === 'repo'`. */
  basename?: string
}

function normalizeRef(ref: string): NormalizedRef {
  const trimmed = ref.trim()
  let raw = trimmed
  if (raw.startsWith('github:')) raw = raw.slice('github:'.length)
  if (/^https?:\/\//.test(raw)) {
    const repoUrl = normalizeRepoUrl(raw)
    return { kind: 'repo', base: repoUrl.toLowerCase(), repoUrl, basename: repoUrl.split('/').pop() ?? repoUrl }
  }
  if (raw.includes('/') && !raw.startsWith('@')) {
    const repoUrl = normalizeRepoUrl(`https://github.com/${raw}`)
    return { kind: 'repo', base: raw.toLowerCase(), repoUrl, basename: raw.split('/').pop() ?? raw }
  }
  return { kind: 'name', base: raw.toLowerCase() }
}

/** Parse owner/repo out of a canonical github.com URL. */
export function repoUrlToOwnerRepo(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url)
    if (u.hostname !== 'github.com') return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0]!, repo: parts[1]! }
  } catch {
    return null
  }
}

class RegistryClientImpl implements RegistryClient {
  private warnings: string[] = []
  private readonly cfg: PmConfig['registry']
  private readonly deps: RegistryClientDeps

  /** Warnings of the most recent `search` / `resolve` run (documented extra). */
  get lastWarnings(): readonly string[] {
    return this.warnings
  }

  constructor(cfg: PmConfig['registry'], deps: RegistryClientDeps) {
    this.cfg = cfg
    this.deps = deps
  }

  /** Gather all three sources concurrently and merge/dedupe them. */
  private async collect(): Promise<RegistryEntry[]> {
    const [awesome, github, npm] = await Promise.all([
      fetchAwesome(this.cfg, this.deps),
      fetchGithub(this.deps),
      fetchNpm(this.cfg, this.deps),
    ])
    const { entries, warnings } = mergeSources([awesome, github, npm])
    this.warnings = warnings
    return entries
  }

  async search(q: string): Promise<RegistryEntry[]> {
    return searchEntries(await this.collect(), q)
  }

  async resolve(name: string): Promise<RegistryEntry | null> {
    const all = await this.collect()
    const ref = normalizeRef(name)

    if (ref.kind === 'repo' && ref.repoUrl) {
      const byUrl = all.find((e) => e.repoUrl === ref.repoUrl)
      if (byUrl) return byUrl
    }

    const hits = all.filter((e) => {
      if (e.name.toLowerCase() === ref.base) return true
      if (e.npmName && e.npmName.toLowerCase() === ref.base) return true
      if (ref.kind === 'repo' && ref.basename) {
        const last = e.repoUrl?.split('/').pop()?.toLowerCase()
        if (last && last === ref.basename.toLowerCase()) return true
      }
      return false
    })
    return hits[0] ?? null
  }

  async latestVersion(entry: RegistryEntry): Promise<string | null> {
    if (entry.npmName) {
      const version = await this.npmLatest(entry.npmName)
      if (version) return version
    }
    if (entry.repoUrl) {
      const head = await this.githubHead(entry.repoUrl)
      if (head) return head
    }
    return null
  }

  /** npm dist-tag `latest` via `npm view <name> version`. */
  private async npmLatest(npmName: string): Promise<string | null> {
    try {
      const res = await this.deps.npm(['view', npmName, 'version'])
      if (res.code === 0) {
        const version = res.stdout.trim()
        if (version) return version
      }
    } catch {
      /* fall through to repo HEAD */
    }
    return null
  }

  /** Default-branch HEAD commit sha via gh api, with an https fallback. */
  private async githubHead(repoUrl: string): Promise<string | null> {
    const parsed = repoUrlToOwnerRepo(repoUrl)
    if (!parsed) return null
    const path = `repos/${parsed.owner}/${parsed.repo}/commits?per_page=1`
    try {
      const res = await this.deps.gh(['api', path, '--jq', '.[0].sha'])
      if (res.code === 0) {
        const sha = res.stdout.trim()
        if (sha) return sha
      }
    } catch {
      /* try https below */
    }
    try {
      const text = await this.deps.fetchText(`https://api.github.com/${path}`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      const parsedJson = JSON.parse(text) as unknown
      if (Array.isArray(parsedJson) && parsedJson.length > 0) {
        const sha = (parsedJson[0] as { sha?: unknown } | null)?.sha
        if (typeof sha === 'string' && sha) return sha
      }
    } catch {
      /* give up */
    }
    return null
  }
}
