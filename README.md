# @dsh-pm/registry

The discovery engine of `dsh pm` — find dsh plugins by merging three
independent sources into one deduped, sorted, **offline-tolerant** registry:

1. **awesome-list** — the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
   README, parsed under its category headings (config `awesomeUrl`).
2. **GitHub topic** — repo search for the `dsh-plugin` topic via the `gh` CLI,
   with a plain `api.github.com` https fallback.
3. **npm keyword** — `npm search --json <keyword>` (config `npmKeyword`,
   default `dsh`), with a registry `/-/v1/search` https fallback.

A GitHub hit and an npm hit for the same project collapse into one
`RegistryEntry` carrying both `repoUrl` and `npmName`; entries dedupe by
normalized repo URL first, then by bare name. Every source degrades
independently — a dead source contributes fewer (or cached) entries and a
warning, **never a rejection**. Offline, the client serves whatever the local
cache last recorded per source.

This package implements the frozen `RegistryClient` contract from
[`@dsh-pm/core`](https://github.com/Jesse-njx/dsh-plugin-manager-core) (spec
§5.1) and exports exactly the §5.2 surface: `createRegistryClient` and a
one-shot `search` convenience.

## Install

Workspace package of the `dsh-plugin-manager` monorepo; consumed through
`@dsh-pm/core` (workspace dep). The product that wires it into DSH is the
plugin manager CLI:

```sh
dsh plugin add github:Jesse-njx/dsh-plugin-manager
```

## Usage

```ts
import { createRegistryClient, search } from '@dsh-pm/registry'
import type { PmConfig } from '@dsh-pm/core'

const cfg: PmConfig['registry'] = {
  awesomeUrl: 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md',
  npmKeyword: 'dsh',
}

const client = createRegistryClient(cfg)

// Filtered, sorted: stars desc, then name.
const hits = await client.search('memory')

// Exact lookup by name, npmName, owner/repo, github:owner/repo or https URL.
const entry = await client.resolve('Jesse-njx/dsh-memory')

// Update-check version: npm dist-tag `latest`, else GitHub default-branch HEAD sha.
const version = await client.latestVersion(entry ?? hits[0]!)

// Warnings of the last run (documented extra beyond the frozen interface):
console.log(client.lastWarnings) // e.g. ["github: 'gh' CLI not found; results from https search"]

// One-shot convenience (spec §5.2):
const all = await search('', cfg)
```

### Result shape

`search`/`resolve` return `RegistryEntry` from `@dsh-pm/core`:

```ts
{
  name: string            // canonical bare name
  repoUrl?: string        // normalized https repo URL (dedupe key #1)
  npmName?: string        // npm package name when published
  description: string
  category: string        // awesome-list heading, or ''
  stars?: number          // GitHub stars when known
  updatedAt?: string      // ISO 8601 of last repo push when known
  source: ('github' | 'npm')[]  // which discovery sources contributed
}
```

## The three sources

| Source | Primary | Fallback | Contributes |
|---|---|---|---|
| awesome | `fetch(awesomeUrl)` | local cache | name, repoUrl, description, category |
| github | `gh api search/repositories?q=topic:dsh-plugin` | https `api.github.com` search | name, repoUrl, stars, updatedAt, description |
| npm | `npm search --json --searchlimit=100 <keyword>` | https `registry.npmjs.org/-/v1/search` | name→npmName, repoUrl, description |

- **Dedupe** — normalized repo URL first (`git+https://…`, `git@github.com:…`,
  trailing `.git` all collapse to `https://github.com/owner/repo`), then bare
  name. Distinct repos that merely share a bare name stay separate. Merged
  metadata is unioned and `source` accumulates distinct contributors.
- **Sorting** — `stars ?? 0` descending, name ascending as tiebreak.
- **Warnings** — at most one per degraded source (`awesome: …`, `github: …`,
  `npm: …`), e.g. `github: 'gh api' failed (exit 1); results from https search`.
  An unparseable awesome row increments a single `awesome: skipped N row(s)`
  warning — the parser never throws.

## Offline behavior

Every source tries its primary path, then its https fallback, then its local
cache, then degrades to zero entries with one warning. Caches are JSON files
written atomically (temp + rename) under:

- `$DSH_PM_CACHE_DIR` if set, else
- `$XDG_CACHE_HOME/dsh-pm`, else
- `~/.cache/dsh-pm`

Cache writes are best-effort: a failed write is swallowed, never fatal. The
default npm runner also gets its own writable cache (`<cacheDir>/npm-cache`)
so a broken global `~/.npm` cache cannot take down the primary npm path.

## Development

```sh
pnpm install            # from the monorepo root (requires packages/core to exist)
pnpm --filter @dsh-pm/registry test        # node --test, 43 tests
pnpm --filter @dsh-pm/registry typecheck
pnpm --filter @dsh-pm/registry build       # tsc → lib/
```

Tests never hit the network except `test/live.test.ts`, which skips when
offline (network guard, mirroring the suite convention). The merge/dedupe
matrix, parser goldens (fixture README committed in `test/fixtures/`) and
every degrade path run against injected fakes (`test/helpers.ts`).

> **`dev/core/` is a build-time-only stub.** `registry` imports types from
> `@dsh-pm/core` (workspace dep) using `import type` only — erased at runtime.
> Because Session 1's `core` had not landed when this package was built, the
> frozen §5.1 contract is transcribed verbatim into `dev/core/index.d.ts`,
> referenced only through the `paths` mapping in `tsconfig.json`, never
> emitted into `lib/`, and never imported at runtime. Delete `dev/` the
> moment the real `core` links — the coordinator can diff the stub against the
> landed types to catch any drift.

## License

MIT — see [LICENSE](./LICENSE).
