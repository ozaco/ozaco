/**
 * `shared` is the bottom layer: every other module (result included) builds on it, so it must never
 * import one of them back — the `Result`-returning helpers live in `std:schema` for that reason.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHARED = join(import.meta.dir, '../../src/shared')

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )

describe('shared layering', () => {
  it('imports no other std module', () => {
    const offenders = sources(SHARED).filter(file =>
      /from '(std:(?!shared')|\.\.\/\.\.\/)/u.test(readFileSync(file, 'utf8')),
    )

    expect(offenders).toEqual([])
  })
})
