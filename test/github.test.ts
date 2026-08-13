import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGithub, parseGhItems, parseGithubApiJson } from '../src/github.ts'
import { makeFakeDeps, tempCacheDir } from './helpers.ts'

const SEARCH_PATH = 'search/repositories?q=topic%3Adsh-plugin+archived%3Afalse&per_page=100'
const HTTPS_URL = `https://api.github.com/${SEARCH_PATH}`

const NDJSON = [
  JSON.stringify({ full_name: 'Jesse-njx/dsh-memory', html_url: 'https://github.com/Jesse-njx/dsh-memory', stargazers_count: 42, pushed_at: '2026-08-01T00:00:00Z', description: 'cited memory' }),
  JSON.stringify({ full_name: 'acme/dsh-toolbox', html_url: 'https://github.com/acme/dsh-toolbox.git', stargazers_count: 7, pushed_at: '2026-07-15T00:00:00Z', description: 'toolbox' }),
  'not json at all',
].join('\n')

const API_JSON = JSON.stringify({
  items: [
    { full_name: 'Jesse-njx/dsh-memory', html_url: 'https://github.com/Jesse-njx/dsh-memory', stargazers_count: 42, pushed_at: '2026-08-01T00:00:00Z', description: 'cited memory' },
    { full_name: 'acme/dsh-toolbox', html_url: 'https://github.com/acme/dsh-toolbox', stargazers_count: 7, pushed_at: '2026-07-15T00:00:00Z', description: 'toolbox' },
  ],
})

test('github: parses ndjson lines from gh api --jq, skipping malformed lines', () => {
  const items = parseGhItems(NDJSON)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    name: 'dsh-memory',
    repoUrl: 'https://github.com/Jesse-njx/dsh-memory',
    stars: 42,
    updatedAt: '2026-08-01T00:00:00Z',
    description: 'cited memory',
  })
  assert.equal(items[1]!.repoUrl, 'https://github.com/acme/dsh-toolbox', 'trailing .git is stripped')
})

test('github: parses a plain JSON array payload', () => {
  const items = parseGhItems(`[${NDJSON.split('\n')[0]}]`)
  assert.equal(items.length, 1)
})

test('github: parses the api.github.com search document', () => {
  const items = parseGithubApiJson(API_JSON)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.name, 'dsh-memory')
})

test('github: parsers never throw on garbage', () => {
  assert.deepEqual(parseGhItems(''), [])
  assert.deepEqual(parseGhItems('not json'), [])
  assert.deepEqual(parseGhItems('{"a":1}\n[bad'), [])
  assert.deepEqual(parseGithubApiJson(''), [])
  assert.deepEqual(parseGithubApiJson('{"items": 3}'), [])
})

test('github: gh CLI success yields entries with no warnings', async () => {
  const deps = makeFakeDeps({ gh: { 'search/repositories': { stdout: NDJSON, stderr: '', code: 0 } } })
  const result = await fetchGithub(deps)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.entries[0]!.source, ['github'])
})

test('github: gh missing falls back to https search', async () => {
  const deps = makeFakeDeps({
    gh: { 'search/repositories': { stdout: '', stderr: 'gh: command not found', code: 127, missing: true } },
    fetchResponses: { [HTTPS_URL]: API_JSON },
  })
  const result = await fetchGithub(deps)
  assert.equal(result.entries.length, 2, 'https fallback served the results')
  assert.equal(result.warnings.length, 1, 'one consolidated warning for the degraded source')
  assert.match(result.warnings[0]!, /gh.*not found/)
})

test('github: gh non-zero with no output falls back to https search', async () => {
  const deps = makeFakeDeps({
    gh: { 'search/repositories': { stdout: '', stderr: 'not authenticated', code: 1 } },
    fetchResponses: { [HTTPS_URL]: API_JSON },
  })
  const result = await fetchGithub(deps)
  assert.equal(result.entries.length, 2)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /gh api' failed/)
})

test('github: gh non-zero with parseable output uses the output', async () => {
  const deps = makeFakeDeps({ gh: { 'search/repositories': { stdout: NDJSON, stderr: 'warning-level noise', code: 1 } } })
  const result = await fetchGithub(deps)
  assert.equal(result.entries.length, 2, 'stdout is still used')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /using its output/)
})

test('github: gh and https both dead serve the cache; no cache degrades to []', async () => {
  const cacheDir = tempCacheDir()
  try {
    const cache = await import('../src/cache.ts')
    await cache.cacheSave(cacheDir, 'github', [{ name: 'cached-plugin', repoUrl: 'https://github.com/o/cached', stars: 1, updatedAt: '', description: 'from cache' }])
    const deps = makeFakeDeps({
      cacheDir,
      gh: { 'search/repositories': { stdout: '', stderr: 'fail', code: 1 } },
      fetchFns: { [HTTPS_URL]: () => { throw new Error('offline') } },
    })
    const result = await fetchGithub(deps)
    assert.equal(result.entries.length, 1, 'cached results are served offline')
    assert.equal(result.entries[0]!.name, 'cached-plugin')
    assert.equal(result.warnings.length, 1, 'one consolidated warning even with two dead paths')
    assert.match(result.warnings[0]!, /using cached results/)

    const deps2 = makeFakeDeps({
      gh: { 'search/repositories': { stdout: '', stderr: 'fail', code: 1 } },
      fetchFns: { [HTTPS_URL]: () => { throw new Error('offline') } },
    })
    const result2 = await fetchGithub(deps2)
    assert.deepEqual(result2.entries, [])
    assert.equal(result2.warnings.length, 1)
    assert.match(result2.warnings[0]!, /no cache available/)
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(cacheDir, { recursive: true, force: true }))
  }
})
