import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CachedDoc<T> {
  /** ISO 8601 timestamp of the successful fetch that produced this cache. */
  savedAt: string
  data: T
}

/**
 * Default cache location: `$DSH_PM_CACHE_DIR`, else `$XDG_CACHE_HOME/dsh-pm`,
 * else `~/.cache/dsh-pm`. Returns undefined when no home directory is
 * resolvable (caching is then disabled, never fatal).
 */
export function defaultCacheDir(): string | undefined {
  const env = process.env.DSH_PM_CACHE_DIR
  if (env) return env
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) return undefined
  const xdg = process.env.XDG_CACHE_HOME
  return join(xdg ?? join(home, '.cache'), 'dsh-pm')
}

/** Read a cached document; returns null on any failure (corrupt/absent file). */
export async function cacheLoad<T>(dir: string, key: string): Promise<CachedDoc<T> | null> {
  try {
    const raw = await readFile(join(dir, `${key}.json`), 'utf8')
    const doc = JSON.parse(raw) as CachedDoc<T>
    if (typeof doc?.savedAt !== 'string' || !('data' in doc)) return null
    return doc
  } catch {
    return null
  }
}

/**
 * Atomically write a cached document (temp file + rename, matching the suite's
 * "files not databases" convention). Best-effort: any failure returns false and
 * is swallowed — a cache that cannot be written must never fail a search.
 */
export async function cacheSave<T>(dir: string, key: string, data: T): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    const doc: CachedDoc<T> = { savedAt: new Date().toISOString(), data }
    const target = join(dir, `${key}.json`)
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(doc), 'utf8')
    await rename(tmp, target)
    return true
  } catch {
    return false
  }
}
