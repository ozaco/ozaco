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
const root = join(import.meta.dirname, '..', '..')

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
