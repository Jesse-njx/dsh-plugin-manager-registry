import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defaultCacheDir } from './cache.ts'
import type { CommandResult, RegistryClientDeps } from './types/index.ts'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BUFFER = 8 * 1024 * 1024
const USER_AGENT = 'dsh-pm-registry/0.1.0'

/**
 * Run a CLI binary. Resolves (never rejects) with a CommandResult:
 * - spawn failure (binary missing) → code 127, `missing: true`
 * - timed out → code 124
 * - non-zero exit → the process exit code
 * - success → code 0
 */
async function runCommand(bin: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string }
    if (e?.code === 'ENOENT') {
      return { stdout: '', stderr: `${bin}: command not found`, code: 127, missing: true }
    }
    if (e?.killed) {
      return { stdout: typeof e.stdout === 'string' ? e.stdout : '', stderr: `${bin}: timed out after ${timeoutMs}ms`, code: 124 }
    }
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : (e?.message ?? String(err)),
      code: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

/**
 * The real I/O wiring used by `createRegistryClient`: global fetch for text
 * documents, the `gh` CLI for GitHub search, and the `npm` CLI for npm
 * search / version lookup.
 */
export function defaultDeps(): RegistryClientDeps {
  const cacheDir = defaultCacheDir()
  return {
    cacheDir,
    fetchText: async (url, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return res.text()
    },
    gh: (args, opts = {}) => runCommand('gh', args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    npm: (args, opts = {}) => {
      // Give npm its own writable cache under the package cache dir so a
      // broken/read-only global ~/.npm cache cannot take down the primary
      // npm search path (observed: EPERM exit 255 with valid stdout).
      const fullArgs = cacheDir ? [...args, '--cache', join(cacheDir, 'npm-cache')] : args
      return runCommand('npm', fullArgs, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    },
  }
}
