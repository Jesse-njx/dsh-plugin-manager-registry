import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchAwesome, normalizeRepoUrl, parseAwesomeReadme } from '../src/awesome.ts'
import { CFG, makeFakeDeps, tempCacheDir } from './helpers.ts'

const FIXTURE = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'awesome-README.md'), 'utf8')

test('awesome: parses list entries under their category headings (golden)', () => {
  const { entries, skipped } = parseAwesomeReadme(FIXTURE)
  assert.equal(skipped, 5, 'TOC anchors, broken url, nested bullet, missing paren are skipped')
  assert.equal(entries.length, 6)
  assert.deepEqual(
    entries.map((e) => e.name),
    ['dsh-memory', 'dsh-transcript', 'dsh-memory-zh', 'no-description', 'dsh-toolbox', '@dsh-memory/bundle'],
  )
  const memory = entries[0]!
  assert.equal(memory.category, 'Sessions & Messages')
  assert.equal(memory.url, 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(memory.description, 'Cited memory over DSH\'s lossless session log.')
  assert.equal(entries[4]!.category, 'Tools & Agents')
  assert.equal(entries[4]!.description, 'A collection of everyday tools.')
  assert.equal(entries[3]!.description, '', 'missing description becomes empty string')
})

test('awesome: dash, em-dash and colon separators all work', () => {
  const { entries } = parseAwesomeReadme(FIXTURE)
  assert.equal(entries[1]!.description, 'Transcript search and summarization')
  assert.equal(entries[2]!.description, 'Chinese docs mirror')
})

test('awesome: never throws on garbage input', () => {
  for (const garbage of ['', '\n\n', 'not markdown at all', '### ', '- [x](https://a.b)', '```\ncode block\n```']) {
    const { entries, skipped } = parseAwesomeReadme(garbage)
    assert.ok(Array.isArray(entries))
    assert.equal(typeof skipped, 'number')
  }
})

test('awesome: normalizeRepoUrl canonicalizes transport prefixes', () => {
  assert.equal(normalizeRepoUrl('https://github.com/Jesse-njx/dsh-memory'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('https://github.com/Jesse-njx/dsh-memory.git'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('git+https://github.com/Jesse-njx/dsh-memory.git'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('git@github.com:Jesse-njx/dsh-memory.git'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('git://github.com/Jesse-njx/dsh-memory'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('ssh://git@github.com/Jesse-njx/dsh-memory'), 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(normalizeRepoUrl('https://github.com/Jesse-njx/dsh-memory/'), 'https://github.com/Jesse-njx/dsh-memory')
})

test('awesome: fetch succeeds, parses, and populates the cache', async () => {
  const cacheDir = tempCacheDir()
  try {
    const deps = makeFakeDeps({ fetchResponses: { [CFG.awesomeUrl]: FIXTURE }, cacheDir })
    const result = await fetchAwesome(CFG, deps)
    assert.equal(result.warnings.length, 1, 'only the unparseable-rows summary warning')
    assert.equal(result.entries.length, 6)
    assert.deepEqual(result.entries[0]!.source, ['github'])
    assert.deepEqual(result.entries[5]!.source, ['npm'], 'npmjs.org URL classifies as npm source')
    const cached = await import('../src/cache.ts')
    const doc = await cached.cacheLoad<string>(cacheDir, 'awesome')
    assert.ok(doc, 'raw markdown is cached on success')
    assert.equal(doc!.data, FIXTURE)
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(cacheDir, { recursive: true, force: true }))
  }
})

test('awesome: fetch failure falls back to the local cache with a warning', async () => {
  const cacheDir = tempCacheDir()
  const CLEAN_MARKDOWN = '# T\n\n## Foo\n\n- [a](https://github.com/o/a) — desc\n'
  try {
    const cache = await import('../src/cache.ts')
    await cache.cacheSave(cacheDir, 'awesome', CLEAN_MARKDOWN)
    const deps = makeFakeDeps({ cacheDir }) // no fetch response → fetchText throws
    const result = await fetchAwesome(CFG, deps)
    assert.equal(result.entries.length, 1, 'cached markdown is served when offline')
    assert.equal(result.entries[0]!.name, 'a')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /using cached list/)
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(cacheDir, { recursive: true, force: true }))
  }
})

test('awesome: fetch failure without cache degrades to [] plus a warning, never throws', async () => {
  const deps = makeFakeDeps({ cacheDir: tempCacheDir() }) // no cache content, no fetch response
  const result = await fetchAwesome(CFG, deps)
  assert.deepEqual(result.entries, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /no cache available/)
})

test('awesome: malformed rows are reported as a summary warning', async () => {
  const deps = makeFakeDeps({ fetchResponses: { [CFG.awesomeUrl]: FIXTURE } })
  const result = await fetchAwesome(CFG, deps)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /skipped 5 unparseable row/)
})
