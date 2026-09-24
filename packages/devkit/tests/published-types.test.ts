import { describe, expect, it } from 'bun:test'
/**
 * No published declaration file may name an in-repo build alias. Inside this monorepo they
 * resolve (every tsconfig maps them), so the damage is invisible here — a consumer that installs
 * the package gets `TS2307: Cannot find module 'std:shared'` and loses the types entirely.
 *
 * This walks the real `dist/` of every package, so it fails on whatever was actually built.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const packages = ['std', 'transport', 'db', 'server', 'client', 'ai', 'cli']
const root = join(import.meta.dirname, '..', '..', '..')

/** `import("std:shared")` and `from 'db:core'` — a specifier, never prose. */
const ALIAS = /(?:import\(|from\s*)(["'])((?:std|db|server|transport|client|ai|cli):[^"']*)\1/gu

const walk = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })

const leaksOf = (pkg: string): readonly string[] => {
  const dist = join(root, 'packages', pkg, 'dist')

  if (!existsSync(dist)) {
    return []
  }

  return walk(dist)
    .filter(file => /\.d\.(?:c|m)?ts$/u.test(file))
    .flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(ALIAS)].map(
        match => `${relative(dist, file)} → ${match[2]}`,
      ),
    )
}

describe('published types', () => {
  for (const pkg of packages) {
    it(`@ozaco/${pkg} declares only package specifiers`, () => {
      expect([pkg, [...new Set(leaksOf(pkg))]]).toEqual([pkg, []])
    })
  }
})

/** `from "@ozaco/std/effect"` — the other packages a declaration file imports. */
const PACKAGE = /from\s*(["'])(@ozaco\/[^"'/]+)[^"']*\1/gu

/** Per entry declaration (`plugins.d.ts` ↔ `plugins.d.cts`; hashed shared chunks are skipped, their
 * names differ per format), the packages each format imports. */
const importsByEntry = (pkg: string): readonly (readonly [string, string[], string[]])[] => {
  const dist = join(root, 'packages', pkg, 'dist')

  if (!existsSync(dist)) {
    return []
  }

  const importsOf = (file: string) =>
    [
      ...new Set(
        [...readFileSync(file, 'utf8').matchAll(PACKAGE)].flatMap(match =>
          match[2] ? [match[2]] : [],
        ),
      ),
    ].toSorted()

  return walk(dist)
    .filter(file => file.endsWith('.d.ts') && !/-[\w-]{8}\.d\.ts$/u.test(file))
    .map(file => [file, file.replace(/\.d\.ts$/u, '.d.cts')] as const)
    .filter(([, cjs]) => existsSync(cjs))
    .map(([esm, cjs]) => [relative(dist, esm), importsOf(esm), importsOf(cjs)] as const)
}

// tsdown builds `.d.cts` in its own pass without the user plugins; without
// `withDeclarationPlugins` the CJS types inline a private copy of every std type instead
describe('published CJS types', () => {
  for (const pkg of packages) {
    it(`@ozaco/${pkg} .d.cts entries import the same packages as .d.ts`, () => {
      for (const [entry, esm, cjs] of importsByEntry(pkg)) {
        expect([entry, cjs]).toEqual([entry, esm])
      }
    })
  }
})
