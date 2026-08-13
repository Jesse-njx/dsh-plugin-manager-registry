import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, RegistryClientDeps } from '../src/types/index.ts'

export const CFG = {
  awesomeUrl: 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md',
  npmKeyword: 'dsh',
}

export interface FakeDeps extends RegistryClientDeps {
  calls: { gh: string[][]; npm: string[][]; fetches: string[] }
}

export type RunnerMap = Record<string, CommandResult | ((args: string[]) => CommandResult | Promise<CommandResult>)>

/**
 * Build injectable fake deps with KEYED dispatch, so a client that runs
 * `collect()` more than once (e.g. `resolve` after `search`) reuses the same
 * fake responses instead of exhausting a positional list:
 *
 * - `fetchResponses` keyed by exact URL (a plain string value, or a thunk)
 * - `gh` keyed by a substring of the api path (args[1]) — e.g. `search/repositories`, `commits`
 * - `npm` keyed by args[0] — `search` or `view`
 * - `fetchFns` keyed by exact URL for throwing/hand-crafted responses
 *
 * Any unmapped command resolves to a generic failure (exit 1), which is what
 * the "dead network" tests rely on.
 */
export function makeFakeDeps(opts: {
  fetchResponses?: Record<string, string | ((url: string) => string)>
  fetchFns?: Record<string, (url: string) => string | Promise<string>>
  gh?: RunnerMap
  npm?: RunnerMap
  cacheDir?: string
} = {}): FakeDeps {
  const calls: FakeDeps['calls'] = { gh: [], npm: [], fetches: [] }

  function resolveRunner(map: RunnerMap | undefined, key: string): ((args: string[]) => CommandResult | Promise<CommandResult>) | null {
    if (!map) return null
    for (const [k, v] of Object.entries(map)) {
      if (key.includes(k)) {
        return typeof v === 'function' ? v : () => v
      }
    }
    return null
  }

  return {
    cacheDir: opts.cacheDir,
    calls,
    fetchText: async (url) => {
      calls.fetches.push(url)
      const fn = opts.fetchFns?.[url]
      if (fn) return fn(url)
      const value = opts.fetchResponses?.[url]
      if (value !== undefined) return typeof value === 'function' ? (value as (u: string) => string)(url) : value
      throw new Error(`fetchText: no fake response for ${url}`)
    },
    gh: async (args) => {
      calls.gh.push(args)
      const fn = resolveRunner(opts.gh, args[1] ?? '')
      if (!fn) return { stdout: '', stderr: 'gh: no fake', code: 1 }
      return fn(args)
    },
    npm: async (args) => {
      calls.npm.push(args)
      const fn = resolveRunner(opts.npm, args[0] ?? '')
      if (!fn) return { stdout: '', stderr: 'npm: no fake', code: 1 }
      return fn(args)
    },
  }
}

/** A writable temp dir for cache tests (caller cleans up). */
export function tempCacheDir(prefix = 'dshpm-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
