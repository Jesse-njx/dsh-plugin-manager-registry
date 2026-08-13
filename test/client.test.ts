import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistryClientWithDeps } from '../src/client.ts'
import { CFG, makeFakeDeps } from './helpers.ts'

const AWESOME_MD = [
  '# Awesome DSH Plugins',
  '',
  '## Memory & Recall',
  '',
  '- [dsh-memory](https://github.com/Jesse-njx/dsh-memory) — cited memory over the session log',
  '- [dsh-nocturne](https://github.com/RealAlexandreAI/dsh-nocturne-memory) — nocturnal memory client',
].join('\n')

const GH_NDJSON = [
  JSON.stringify({ full_name: 'Jesse-njx/dsh-memory', html_url: 'https://github.com/Jesse-njx/dsh-memory', stargazers_count: 42, pushed_at: '2026-08-01T00:00:00Z', description: 'cited memory over the session log' }),
  JSON.stringify({ full_name: 'acme/dsh-routines', html_url: 'https://github.com/acme/dsh-routines', stargazers_count: 9, pushed_at: '2026-07-01T00:00:00Z', description: 'scheduled agents' }),
].join('\n')

const NPM_JSON = JSON.stringify([
  { name: '@dsh-memory/bundle', version: '0.1.0', description: 'cited memory', links: { repository: 'git+https://github.com/Jesse-njx/dsh-memory.git' } },
  { name: 'dsh-routines', version: '2.0.0', description: 'scheduled agents', links: { repository: 'https://github.com/acme/dsh-routines' } },
])

const GITHUB_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const MEMORY_COMMITS_URL = 'https://api.github.com/repos/Jesse-njx/dsh-memory/commits?per_page=1'

/** Fully healthy fakes: awesome README, gh search + commits, npm search + view. */
function fullDeps(overrides: Parameters<typeof makeFakeDeps>[0] = {}) {
  return makeFakeDeps({
    fetchResponses: { [CFG.awesomeUrl]: AWESOME_MD },
    gh: {
      'search/repositories': { stdout: GH_NDJSON, stderr: '', code: 0 },
      commits: { stdout: `${GITHUB_SHA}\n`, stderr: '', code: 0 },
    },
    npm: {
      search: { stdout: NPM_JSON, stderr: '', code: 0 },
      view: { stdout: '0.1.0\n', stderr: '', code: 0 },
    },
    ...overrides,
  })
}

test('client: search merges all three sources and exposes lastWarnings', async () => {
  const client = createRegistryClientWithDeps(CFG, fullDeps())
  const all = await client.search('')
  assert.equal(all.length, 3, 'dsh-memory (github+awesome+npm), dsh-nocturne (awesome), dsh-routines (github+npm)')
  const memory = all.find((e) => e.name === 'dsh-memory')
  assert.ok(memory)
  assert.equal(memory!.repoUrl, 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(memory!.npmName, '@dsh-memory/bundle')
  assert.equal(memory!.category, 'Memory & Recall')
  assert.equal(memory!.stars, 42)
  assert.deepEqual(memory!.source, ['github', 'npm'])
  assert.deepEqual(client.lastWarnings, [])
})

test('client: search sorts by stars desc and filters by query', async () => {
  const client = createRegistryClientWithDeps(CFG, fullDeps())
  const hits = await client.search('routine')
  assert.deepEqual(hits.map((e) => e.name), ['dsh-routines'])
  const all = await client.search('')
  assert.equal(all[0]!.name, 'dsh-memory', '42 stars beats 9')
})

test('client: resolve by bare name, npmName, owner/repo and https URL', async () => {
  const client = createRegistryClientWithDeps(CFG, fullDeps())
  assert.equal((await client.resolve('dsh-memory'))?.name, 'dsh-memory')
  assert.equal((await client.resolve('@dsh-memory/bundle'))?.name, 'dsh-memory', 'npmName resolves to the merged entry')
  assert.equal((await client.resolve('Jesse-njx/dsh-memory'))?.name, 'dsh-memory', 'owner/repo resolves by repoUrl')
  assert.equal((await client.resolve('github:acme/dsh-routines'))?.name, 'dsh-routines', 'github: prefix resolves')
  assert.equal((await client.resolve('https://github.com/acme/dsh-routines'))?.name, 'dsh-routines')
  assert.equal(await client.resolve('no-such-plugin'), null)
})

test('client: latestVersion uses npm dist-tag for npmName and gh HEAD for github', async () => {
  const client = createRegistryClientWithDeps(CFG, fullDeps())
  const memory = (await client.resolve('dsh-memory'))!
  assert.equal(await client.latestVersion(memory), '0.1.0', 'npm dist-tag wins when both are known')
  const routines = (await client.resolve('dsh-routines'))!
  assert.equal(await client.latestVersion(routines), '0.1.0')
})

test('client: latestVersion falls back to github HEAD when npm view fails', async () => {
  const client = createRegistryClientWithDeps(
    CFG,
    fullDeps({ npm: { search: { stdout: NPM_JSON, stderr: '', code: 0 }, view: { stdout: '', stderr: 'network error', code: 1 } } }),
  )
  const memory = (await client.resolve('dsh-memory'))!
  assert.equal(await client.latestVersion(memory), GITHUB_SHA)
})

test('client: latestVersion returns null when every path fails', async () => {
  const client = createRegistryClientWithDeps(
    CFG,
    fullDeps({
      npm: { search: { stdout: NPM_JSON, stderr: '', code: 0 }, view: { stdout: '', stderr: 'fail', code: 1 } },
      gh: {
        'search/repositories': { stdout: GH_NDJSON, stderr: '', code: 0 },
        commits: { stdout: '', stderr: 'offline', code: 1 },
      },
      fetchFns: { [MEMORY_COMMITS_URL]: () => { throw new Error('offline') } },
    }),
  )
  const memory = (await client.resolve('dsh-memory'))!
  assert.equal(await client.latestVersion(memory), null)
})

test('client: a fully dead network degrades to [] with one warning per source, never rejects', async () => {
  const client = createRegistryClientWithDeps(CFG, makeFakeDeps()) // nothing mapped → every source dead
  const entries = await client.search('memory')
  assert.deepEqual(entries, [])
  assert.equal(client.lastWarnings.length, 3, 'one warning per dead source')
  for (const w of client.lastWarnings) assert.ok(w.startsWith('awesome:') || w.startsWith('github:') || w.startsWith('npm:'))
  assert.equal(await client.resolve('dsh-memory'), null)
})

test('client: cache is written per source on success and served offline on the next run', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cacheDir = mkdtempSync(join(tmpdir(), 'dshpm-client-'))
  try {
    const online = createRegistryClientWithDeps(CFG, fullDeps({ cacheDir }))
    const first = await online.search('memory')
    assert.equal(first.length, 2, 'dsh-memory + dsh-nocturne match "memory"')

    // Second run: every source is dead, but the caches serve the same data.
    const offline = createRegistryClientWithDeps(
      CFG,
      makeFakeDeps({
        cacheDir,
        gh: { 'search/repositories': { stdout: '', stderr: 'offline', code: 1 } },
        npm: { search: { stdout: '', stderr: 'offline', code: 1 } },
      }),
    )
    const second = await offline.search('memory')
    const names = second.map((e) => e.name).sort()
    assert.deepEqual(names, ['dsh-memory', 'dsh-nocturne'], 'offline run serves cached entries')
    assert.ok(offline.lastWarnings.length >= 3, 'offline sources warn')
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('client: concurrent searches do not leak warnings between runs', async () => {
  const clientGood = createRegistryClientWithDeps(CFG, fullDeps())
  const clientBad = createRegistryClientWithDeps(CFG, makeFakeDeps())
  await clientGood.search('')
  await clientBad.search('')
  assert.deepEqual(clientGood.lastWarnings, [])
  assert.equal(clientBad.lastWarnings.length, 3)
})
