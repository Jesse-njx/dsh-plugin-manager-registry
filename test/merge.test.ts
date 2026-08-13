import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RegistryEntry } from '@dsh-pm/core'
import { mergeSources, searchEntries } from '../src/merge.ts'
import type { SourceResult } from '../src/types/index.ts'

function res(entries: RegistryEntry[], warnings: string[] = []): SourceResult {
  return { entries, warnings }
}

test('merge: npm hit and github hit for the same project collapse into one entry', () => {
  const github: RegistryEntry = {
    name: 'dsh-memory',
    repoUrl: 'https://github.com/Jesse-njx/dsh-memory',
    description: 'cited memory',
    category: '',
    stars: 42,
    source: ['github'],
  }
  const npm: RegistryEntry = {
    name: '@dsh-memory/bundle',
    npmName: '@dsh-memory/bundle',
    repoUrl: 'git+https://github.com/Jesse-njx/dsh-memory.git',
    description: '',
    category: '',
    source: ['npm'],
  }
  const { entries } = mergeSources([res([github]), res([npm])])
  assert.equal(entries.length, 1, 'repoUrl dedupe collapses the pair')
  const merged = entries[0]!
  assert.equal(merged.repoUrl, 'https://github.com/Jesse-njx/dsh-memory', 'normalized repo URL is kept')
  assert.equal(merged.npmName, '@dsh-memory/bundle', 'npmName is carried onto the github entry')
  assert.deepEqual(merged.source, ['github', 'npm'], 'sources union without duplicates')
  assert.equal(merged.stars, 42)
})

test('merge: awesome category is carried when a github entry also appears in the list', () => {
  const awesome: RegistryEntry = {
    name: 'dsh-memory',
    repoUrl: 'https://github.com/Jesse-njx/dsh-memory',
    description: 'list description',
    category: 'Sessions & Messages',
    source: ['github'],
  }
  const github: RegistryEntry = {
    name: 'dsh-memory',
    repoUrl: 'https://github.com/Jesse-njx/dsh-memory',
    description: 'repo description',
    category: '',
    stars: 12,
    source: ['github'],
  }
  const { entries } = mergeSources([res([awesome]), res([github])])
  assert.equal(entries.length, 1)
  const merged = entries[0]!
  assert.equal(merged.category, 'Sessions & Messages')
  assert.equal(merged.stars, 12)
  assert.equal(merged.description, 'list description', 'first source (awesome) keeps its description')
})

test('merge: second pass dedupes by bare name when repoUrl is absent', () => {
  const a: RegistryEntry = { name: 'dsh-toolbox', description: 'fuller', category: '', source: ['npm'], npmName: 'dsh-toolbox' }
  const b: RegistryEntry = { name: 'dsh-toolbox', description: '', category: '', source: ['github'] }
  const { entries } = mergeSources([res([a]), res([b])])
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0]!.source, ['npm', 'github'])
})

test('merge: distinct repos with the same bare name survive as separate entries', () => {
  const a: RegistryEntry = { name: 'dsh-memory', repoUrl: 'https://github.com/Jesse-njx/dsh-memory', description: '', category: '', source: ['github'] }
  const b: RegistryEntry = { name: 'dsh-memory', repoUrl: 'https://github.com/other/dsh-memory', description: '', category: '', source: ['github'] }
  const { entries } = mergeSources([res([a]), res([b])])
  assert.equal(entries.length, 2, 'repoUrl key wins over bare name')
})

test('merge: warnings are flattened across sources in order', () => {
  const { warnings } = mergeSources([res([], ['w-awesome']), res([], ['w-github']), res([], ['w-npm'])])
  assert.deepEqual(warnings, ['w-awesome', 'w-github', 'w-npm'])
})

test('search: filters by substring over name, npmName, description and category', () => {
  const entries: RegistryEntry[] = [
    { name: 'dsh-memory', description: 'cited memory', category: 'Sessions & Messages', source: ['github'] },
    { name: 'dsh-toolbox', npmName: '@acme/toolbox', description: 'tools', category: '', source: ['npm'] },
    { name: 'alpha', description: 'mentions memory in body', category: '', source: ['github'] },
    { name: 'beta', description: 'no match here', category: 'Memory & Recall', source: ['github'] },
  ]
  assert.deepEqual(searchEntries(entries, 'memory').map((e) => e.name), ['alpha', 'beta', 'dsh-memory'])
  assert.deepEqual(searchEntries(entries, 'toolbox').map((e) => e.name), ['dsh-toolbox'])
  assert.deepEqual(searchEntries(entries, 'TOOLS').map((e) => e.name), ['dsh-toolbox'], 'case-insensitive')
  assert.equal(searchEntries(entries, 'zzz').length, 0)
})

test('search: empty query returns everything; sorted by stars desc then name', () => {
  const entries: RegistryEntry[] = [
    { name: 'zeta', description: '', category: '', stars: 5, source: ['github'] },
    { name: 'alpha', description: '', category: '', source: ['npm'] },
    { name: 'beta', description: '', category: '', stars: 5, source: ['github'] },
    { name: 'gamma', description: '', category: '', stars: 9, source: ['github'] },
  ]
  const sorted = searchEntries(entries, '')
  assert.deepEqual(
    sorted.map((e) => e.name),
    ['gamma', 'beta', 'zeta', 'alpha'],
    'stars desc, then name asc; unknown stars sort as 0',
  )
})
