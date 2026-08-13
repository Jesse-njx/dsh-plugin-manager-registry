import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistryClient } from '../src/client.ts'

/**
 * Live tests against the REAL awesome-dsh-plugin README, GitHub (gh + https)
 * and the npm registry. They skip gracefully when offline (network guard,
 * mirroring the dsh-memory network-skip convention) and only assert hard
 * facts when every source is healthy.
 */

const CFG = {
  awesomeUrl: 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md',
  npmKeyword: 'dsh',
}

async function online(): Promise<boolean> {
  try {
    const res = await fetch(CFG.awesomeUrl, { signal: AbortSignal.timeout(8000) })
    return res.ok
  } catch {
    return false
  }
}

/** True when no source failed outright (fetch/cache warnings only). */
function healthy(warnings: readonly string[]): boolean {
  return !warnings.some((w) => /failed|not found|no cache|errored/.test(w))
}

test('live: real search across all three sources finds dsh-memory (skips offline)', async (t) => {
  if (!(await online())) return t.skip('offline: network guard')
  const client = createRegistryClient(CFG)
  const entries = await client.search('dsh-memory')
  assert.ok(Array.isArray(entries), 'search always resolves to an array')
  const memory = entries.find((e) => e.name === 'dsh-memory')
  if (healthy(client.lastWarnings)) {
    assert.ok(memory, 'with healthy sources the real dsh-memory repo must be discoverable')
    assert.equal(memory!.repoUrl, 'https://github.com/Jesse-njx/dsh-memory')
  }
})

test('live: full merged set is sorted by stars when sources are healthy (skips offline)', async (t) => {
  if (!(await online())) return t.skip('offline: network guard')
  const client = createRegistryClient(CFG)
  const all = await client.search('')
  assert.ok(Array.isArray(all))
  if (healthy(client.lastWarnings)) {
    assert.ok(all.length >= 20, `expected a non-trivial merged set, got ${all.length}`)
    assert.ok(all.some((e) => e.stars !== undefined), 'a healthy github source contributes star counts')
    const stars = all.map((e) => e.stars ?? 0)
    for (let i = 1; i < stars.length; i++) {
      assert.ok(stars[i - 1]! >= stars[i]!, `sort invariant broken at index ${i}`)
    }
  }
})

test('live: resolve + latestVersion on the real dsh-memory repo (skips offline)', async (t) => {
  if (!(await online())) return t.skip('offline: network guard')
  const client = createRegistryClient(CFG)
  const resolved = await client.resolve('Jesse-njx/dsh-memory')
  if (!resolved) {
    if (client.lastWarnings.length > 0) return t.skip(`sources degraded: ${client.lastWarnings.join('; ')}`)
    assert.fail('with healthy sources resolve must find the real dsh-memory repo')
    return
  }
  assert.equal(resolved.repoUrl, 'https://github.com/Jesse-njx/dsh-memory')
  assert.equal(resolved.name, 'dsh-memory')
  const version = await client.latestVersion(resolved)
  assert.ok(typeof version === 'string' && version.length >= 7, 'latestVersion returns a semver or commit sha')
})
