import type { PluginSource } from '@dsh-pm/core'

/** One discovery source's raw contribution before merging. */
export interface SourceResult {
  entries: DiscoveredEntry[]
  warnings: string[]
}

/**
 * Internal pre-merge entry. Every metadata field is optional because each
 * source knows a different subset; `mergeSources` fills the gaps.
 */
export interface DiscoveredEntry {
  /** Canonical bare name (dedupe key #2). */
  name: string
  /** Normalized https repo URL (dedupe key #1). */
  repoUrl?: string
  /** npm package name when the project is published to npm. */
  npmName?: string
  description?: string
  /** awesome-list heading, or '' when unknown. */
  category?: string
  stars?: number
  updatedAt?: string
  /** Which discovery sources contributed ('github' | 'npm'). */
  source: PluginSource[]
}

/** Result of shelling out to a CLI (gh / npm). Never throws. */
export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  /** true when the binary itself could not be spawned (ENOENT). */
  missing?: boolean
}

/**
 * Injectable I/O the client needs. `createRegistryClient` wires real
 * implementations (global fetch, `gh`, `npm`); tests inject fakes so no
 * unit test ever touches the network or a subprocess.
 */
export interface RegistryClientDeps {
  /** Fetch a UTF-8 text document (awesome README or https API fallbacks). */
  fetchText(url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<string>
  /** Run `gh` with args. Resolves with `missing: true` when gh is absent. */
  gh(args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>
  /** Run `npm` with args. Resolves with `missing: true` when npm is absent. */
  npm(args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>
  /** Directory for per-source JSON caches; undefined disables caching. */
  cacheDir?: string
}
