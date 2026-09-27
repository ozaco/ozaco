import { describe, expect, it } from 'bun:test'
/**
 * A published std subpath is declared in FIVE places — package.json `exports`, the tsdown entry
 * map, tsconfig.paths.json, devkit's `STD_MODULES` and devkit's ambient module block — and every
 * downstream package maps the ones it imports. `std:trace` must be in all of them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const packages = join(root, '..')

const read = (path: string): string => readFileSync(path, 'utf8')

const manifest = JSON.parse(read(join(root, 'package.json'))) as {
  exports: Record<string, { source: string }>
}

const subpathsOfPackage = (): string[] =>
  Object.keys(manifest.exports).map(key => key.replace(/^\.\//u, ''))

const subpathsOfTsdown = (): string[] =>
  [...read(join(root, 'tsdown.config.ts')).matchAll(/^\s{4}'?([\w/-]+)'?:\s*'\.\//gmu)].map(
    match => match[1]!,
  )

const subpathsOfPaths = (): string[] =>
  [...read(join(root, 'tsconfig.paths.json')).matchAll(/"std:([\w/-]+)":/gu)].map(
    match => match[1]!,
  )

const subpathsOfResolve = (): string[] =>
  [
    ...read(join(packages, 'devkit', 'src', 'resolve.ts')).matchAll(
      /'std:[\w/-]+':\s*\{\s*subpath:\s*'([\w/-]*)'/gu,
    ),
  ].map(match => match[1]!)

const subpathsOfAmbient = (): string[] =>
  [...read(join(packages, 'devkit', 'ambient.d.ts')).matchAll(/'@ozaco\/std\/([\w/-]+)';/gu)].map(
    match => match[1]!,
  )

describe('std — published subpaths', () => {
  it('the five registries declare the same set, std:trace included', () => {
    const expected = subpathsOfPackage().toSorted()

    expect(expected).toContain('trace')
    expect(subpathsOfTsdown().toSorted()).toEqual(expected)
    expect(subpathsOfPaths().toSorted()).toEqual(expected)
    expect(subpathsOfResolve().toSorted()).toEqual(expected)
    expect(subpathsOfAmbient().toSorted()).toEqual(expected)
  })

  it('every declared source file exists', () => {
    for (const [subpath, { source }] of Object.entries(manifest.exports)) {
      expect([subpath, existsSync(join(root, source))]).toEqual([subpath, true])
    }
  })

  it('the packages built on std map std:trace to its dist', () => {
    for (const pkg of ['server', 'db', 'client', 'transport']) {
      const paths = read(join(packages, pkg, 'tsconfig.paths.json'))
      expect([
        pkg,
        paths.includes('"std:trace": ["./node_modules/@ozaco/std/dist/trace"]'),
      ]).toEqual([pkg, true])
    }
  })
})
