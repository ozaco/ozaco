import { describe, expect, it } from 'bun:test'
/**
 * One published subpath has to be declared in FIVE places — package.json `exports`, the tsdown
 * entry map, tsconfig.paths.json, devkit's `DB_MODULES` and devkit's ambient module block.
 * Nothing but this test notices when they drift apart.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const devkit = join(root, '..', 'devkit')

const read = (path: string): string => readFileSync(path, 'utf8')

const exportsOf = (): Record<string, string> => {
  const map = JSON.parse(read(join(root, 'package.json'))).exports as Record<
    string,
    { source: string }
  >

  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key.replace(/^\.\/?/u, ''), value.source]),
  )
}

/** the tsdown entry keys, `index` standing for the root subpath. */
const subpathsOfTsdown = (): string[] =>
  [...read(join(root, 'tsdown.config.ts')).matchAll(/^\s{4}'?([\w/-]+)'?:\s*'\.\//gmu)].map(
    match => (match[1] === 'index' ? '' : match[1]!),
  )

const subpathsOfPaths = (): string[] =>
  [...read(join(root, 'tsconfig.paths.json')).matchAll(/"db:([\w/-]+)":/gu)].map(match =>
    match[1] === 'core' ? '' : match[1]!,
  )

const subpathsOfResolve = (): string[] =>
  [
    ...read(join(devkit, 'src', 'resolve.ts')).matchAll(
      /'db:[\w/-]+':\s*\{\s*subpath:\s*'([\w/-]*)'/gu,
    ),
  ].map(match => match[1]!)

const subpathsOfAmbient = (): string[] =>
  [...read(join(devkit, 'ambient.d.ts')).matchAll(/@ozaco\/db(\/[\w/-]+)?';/gu)].map(match =>
    (match[1] ?? '').replace(/^\//u, ''),
  )

describe('db — published subpaths', () => {
  it('the five registries declare the same set', () => {
    const expected = Object.keys(exportsOf()).toSorted()

    expect(expected.length).toBeGreaterThan(5)
    expect(subpathsOfTsdown().toSorted()).toEqual(expected)
    expect(subpathsOfPaths().toSorted()).toEqual(expected)
    expect(subpathsOfResolve().toSorted()).toEqual(expected)
    expect(subpathsOfAmbient().toSorted()).toEqual(expected)
  })

  it('every declared source file exists', () => {
    for (const [subpath, source] of Object.entries(exportsOf())) {
      expect([subpath, existsSync(join(root, source))]).toEqual([subpath, true])
    }
  })
})
