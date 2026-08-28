import { describe, expect, it } from 'bun:test'

/**
 * The build plugin's contract, in both directions:
 *
 *   INPUT   both spellings resolve — `std:shared` (the in-repo alias) and `@ozaco/std/shared`
 *           (what a source file may already say).
 *   OUTPUT  only the package form ever leaves the build. That includes declaration files, whose
 *           inline `import("std:shared")` type queries never pass through module resolution —
 *           the aliases that used to ship there resolve inside this repo and fail in every
 *           consumer with `TS2307: Cannot find module 'std:shared'`.
 */
import { dbResolve, stdResolve } from '../src/resolve'

const std = stdResolve.rolldown()
const db = dbResolve.rolldown()

const resolved = (plugin: typeof std, source: string): unknown =>
  (plugin.resolveId as (id: string) => unknown)(source)

const rendered = (plugin: typeof std, code: string, fileName: string): string | null => {
  const out = (plugin.renderChunk as (c: string, chunk: { fileName: string }) => unknown)(code, {
    fileName,
  })

  return out === null || out === undefined ? null : (out as { code: string }).code
}

describe('devkit — resolve', () => {
  it('accepts the alias AND the package specifier, and answers the package form', () => {
    const target = { id: '@ozaco/std/shared', external: true }

    expect(resolved(std, 'std:shared')).toEqual(target)
    expect(resolved(std, '@ozaco/std/shared')).toEqual(target)

    // the root subpath has no trailing segment
    expect(resolved(db, 'db:core')).toEqual({ id: '@ozaco/db', external: true })
    expect(resolved(db, '@ozaco/db')).toEqual({ id: '@ozaco/db', external: true })

    // anything else is not ours
    expect(resolved(std, 'zod')).toBeUndefined()
    expect(resolved(std, 'std:nope')).toBeUndefined()
  })

  it('rewrites the aliases a declaration file carries — and nothing else', () => {
    const dts = [
      `declare const E: import("std:shared").Tags<"db", []>;`,
      `import type { Operation } from 'std:effect';`,
      `declare const B: import("std:io/impl/bun").Io;`,
      `/** the registered \`std:codec\` — a doc comment, not a specifier */`,
    ].join('\n')

    const out = rendered(std, dts, 'index.d.ts')!

    expect(out).toContain('import("@ozaco/std/shared")')
    expect(out).toContain(`from '@ozaco/std/effect'`)

    // the longer specifier wins over its own prefix (`std:io` must not eat `std:io/impl/bun`)
    expect(out).toContain('import("@ozaco/std/io/impl/bun")')
    expect(out).not.toContain('@ozaco/std/io"')

    // prose is left alone
    expect(out).toContain('the registered `std:codec` — a doc comment')
  })

  it('leaves javascript chunks and sourceDir builds alone', () => {
    const code = `import x from "std:shared";`

    expect(rendered(std, code, 'index.js')).toBeNull()

    // a `sourceDir` build inlines real files; its declarations never name an alias
    const inlined = stdResolve.rolldown({ sourceDir: './src' })
    expect(rendered(inlined, `import("std:shared")`, 'index.d.ts')).toBeNull()
    expect(resolved(inlined, 'std:shared')).toBe('./src/shared/index.ts')
    expect(resolved(inlined, '@ozaco/std/shared')).toBe('./src/shared/index.ts')
  })
})
