import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchNpm, parseNpmRegistrySearch, parseNpmSearchJson } from '../src/npm.ts'
import { CFG, makeFakeDeps, tempCacheDir } from './helpers.ts'

const REGISTRY_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords%3Adsh&size=100'

const NPM_SEARCH_JSON = JSON.stringify([
  {
    name: '@dsh-memory/bundle',
    version: '0.1.0',
    description: 'cited memory',
    keywords: ['dsh', 'dsh-plugin'],
    date: '2026-08-01T00:00:00.000Z',
    links: { npm: 'https://www.npmjs.com/package/@dsh-memory/bundle', repository: 'git+https://github.com/Jesse-njx/dsh-memory.git' },
  },
  {
    name: 'dsh-shell',
    version: '1.0.0',
    description: 'a shell',
    links: { npm: 'https://www.npmjs.com/package/dsh-shell' },
  },
  'not an object',
])

const REGISTRY_JSON = JSON.stringify({
  objects: [
    { package: { name: '@dsh-memory/bundle', description: 'cited memory', links: { repository: 'https://github.com/Jesse-njx/dsh-memory.git' } } },
    { package: { name: 'dsh-shell', description: 'a shell' } },
  ],
})

test('npm: parses npm search --json output, skipping non-objects', () => {
  const items = parseNpmSearchJson(NPM_SEARCH_JSON)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    name: '@dsh-memory/bundle',
    repoUrl: 'https://github.com/Jesse-njx/dsh-memory',
    description: 'cited memory',
  })
  assert.equal(items[1]!.repoUrl, undefined, 'missing repository link stays undefined')
})

test('npm: parses the registry /-/v1/search document', () => {
  const items = parseNpmRegistrySearch(REGISTRY_JSON)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.name, '@dsh-memory/bundle')
  assert.equal(items[0]!.repoUrl, 'https://github.com/Jesse-njx/dsh-memory')
})

test('npm: parsers never throw on garbage', () => {
  assert.deepEqual(parseNpmSearchJson(''), [])
  assert.deepEqual(parseNpmSearchJson('not json'), [])
  assert.deepEqual(parseNpmSearchJson('{"a":1}'), [])
  assert.deepEqual(parseNpmRegistrySearch(''), [])
  assert.deepEqual(parseNpmRegistrySearch('{"objects": 5}'), [])
})

test('npm: CLI success yields entries with no warnings', async () => {
  const deps = makeFakeDeps({ npm: { search: { stdout: NPM_SEARCH_JSON, stderr: '', code: 0 } } })
  const result = await fetchNpm(CFG, deps)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.entries[0]!.source, ['npm'])
  assert.equal(result.entries[0]!.npmName, '@dsh-memory/bundle')
})

test('npm: CLI non-zero with valid stdout still uses the output', async () => {
  const deps = makeFakeDeps({ npm: { search: { stdout: NPM_SEARCH_JSON, stderr: 'EPERM noise', code: 255 } } })
  const ok = await fetchNpm(CFG, deps)
  assert.equal(ok.entries.length, 2)
  assert.equal(ok.warnings.length, 1)
  assert.match(ok.warnings[0]!, /using its output/)
})

test('npm: CLI missing falls back to registry search', async () => {
  const deps = makeFakeDeps({
    npm: { search: { stdout: '', stderr: 'npm: command not found', code: 127, missing: true } },
    fetchResponses: { [REGISTRY_URL]: REGISTRY_JSON },
  })
  const result = await fetchNpm(CFG, deps)
  assert.equal(result.entries.length, 2, 'registry fallback served the results')
  assert.equal(result.warnings.length, 1, 'one consolidated warning')
  assert.match(result.warnings[0]!, /npm.*not found/)
})

test('npm: CLI and registry both dead serve the cache; no cache degrades to []', async () => {
  const cacheDir = tempCacheDir()
  try {
    const cache = await import('../src/cache.ts')
    await cache.cacheSave(cacheDir, 'npm', [{ name: 'cached-npm', repoUrl: 'https://github.com/o/cached', description: 'from cache' }])
    const deps = makeFakeDeps({
      cacheDir,
      npm: { search: { stdout: '', stderr: 'fail', code: 1 } },
      fetchFns: { [REGISTRY_URL]: () => { throw new Error('offline') } },
    })
    const result = await fetchNpm(CFG, deps)
    assert.equal(result.entries.length, 1, 'cached results are served offline')
    assert.equal(result.entries[0]!.name, 'cached-npm')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /using cached results/)

    const deps2 = makeFakeDeps({
      npm: { search: { stdout: '', stderr: 'fail', code: 1 } },
      fetchFns: { [REGISTRY_URL]: () => { throw new Error('offline') } },
    })
    const result2 = await fetchNpm(CFG, deps2)
    assert.deepEqual(result2.entries, [])
    assert.equal(result2.warnings.length, 1)
    assert.match(result2.warnings[0]!, /no cache available/)
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(cacheDir, { recursive: true, force: true }))
  }
})
