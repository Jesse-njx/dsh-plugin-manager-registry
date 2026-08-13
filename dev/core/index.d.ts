/**
 * DEV-ONLY type stub for `@dsh-pm/core` (Session 1, not yet landed in the
 * workspace when Session 2 builds `registry`).
 *
 * This file is a VERBATIM transcription of §5.1 of the dsh-plugin-manager
 * spec (normative, frozen). It exists so `registry` can typecheck and emit
 * declarations against the exact published contract before `core` compiles.
 * It is referenced ONLY through the `paths` mapping in tsconfig.json, is
 * never emitted into `lib/`, and is never imported at runtime (registry only
 * ever uses `import type` from `@dsh-pm/core`, which TypeScript erases).
 *
 * Delete this directory the moment `packages/core` lands and `pnpm install`
 * links the real package. Keep it byte-for-byte in sync with §5.1 until then.
 */

export type PluginSource = 'npm' | 'github' | 'local'

export interface PluginManifest {
  name: string
  version: string
  description: string
  repository?: string
  topics: string[]
  bundle: {
    patchPath: string
    entryId: string
    entryName: string
  }
}

export interface InstalledPlugin {
  name: string
  version: string
  source: PluginSource
  ref: string
  profile: string
  enabled: boolean
  installedAt: string
  lastChecked: string | null
}

export interface ProfileTarget {
  profiles: string[]
}

export interface RegistryEntry {
  name: string
  repoUrl?: string
  npmName?: string
  description: string
  category: string
  stars?: number
  updatedAt?: string
  source: PluginSource[]
}

export interface RegistryResult {
  entries: RegistryEntry[]
  warnings: string[]
}

export interface PmConfig {
  registry: { awesomeUrl: string; npmKeyword: string }
  profiles: string[]
  stateFile: string
  gitInstall: { depth: number; build: boolean }
}

export type PmErrorCode =
  | 'MANIFEST_INVALID'
  | 'BUNDLE_PATCH_MISSING'
  | 'SOURCE_UNRESOLVED'
  | 'INSTALL_FAILED'
  | 'STATE_CORRUPT'
  | 'REGISTRY_UNREACHABLE'

export class PmError extends Error {
  readonly code: PmErrorCode
  readonly detail?: unknown
  constructor(code: PmErrorCode, message: string, detail?: unknown)
}

export interface ManifestParser {
  parse(dir: string): Promise<PluginManifest>
}

export function createManifestParser(): ManifestParser

export interface RegistryClient {
  search(q: string): Promise<RegistryEntry[]>
  resolve(name: string): Promise<RegistryEntry | null>
  latestVersion(entry: RegistryEntry): Promise<string | null>
}

export interface StateStore {
  load(): Promise<InstalledPlugin[]>
  save(rows: InstalledPlugin[]): Promise<void>
  upsert(row: InstalledPlugin): Promise<void>
  remove(name: string, profile?: string): Promise<void>
}

export function createStateStore(stateFile: string): StateStore
