import { describe, expect, it } from 'bun:test'

import { sql } from '@ozaco/db'
import { toSurreal } from '@ozaco/db/impl/surreal'
import type { Column, MongoFilter } from '@ozaco/db/realtime'
import { compileFilter } from '@ozaco/db/realtime'
import type { AnyType } from '@ozaco/std/shared'

const columns: readonly Column[] = [
  {
    name: 'name',
    kind: 'text',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
  },
  {
    name: 'slug',
    kind: 'text',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
  },
]

// the exact query shape the wizard's list/find builds: compiled Mongo filter inside a SELECT
// (typed against the doc shape; the compiler API takes the untyped default form, like the wizard)
const compile = (filter: MongoFilter<{ name: string; slug: string }>) => {
  const compiled = compileFilter(filter as AnyType, columns)
  const token = sql`SELECT * FROM ${sql.identifier(['agents'])} WHERE ${compiled!}`
  return toSurreal(token as AnyType)
}

describe('toSurreal LIKE translation', () => {
  it('translates the wizard q-search shape (OR of %term% LIKEs) to string::contains', () => {
    // what `GET /agents?q=dedas` compiles to over `search: ['name', 'slug']`
    const out = compile({ $or: [{ name: { $like: '%dedas%' } }, { slug: { $like: '%dedas%' } }] })
    expect(out.text).not.toContain('LIKE')
    expect(out.text).toContain('string::contains(`name`, $p1)')
    expect(out.text).toContain('string::contains(`slug`, $p2)')
    expect(out.bindings).toEqual({ p1: 'dedas', p2: 'dedas' })
  })

  it('maps prefix / suffix / bare patterns to starts_with / ends_with / equality', () => {
    const prefix = compile({ name: { $like: 'dedas%' } })
    expect(prefix.text).toContain('string::starts_with(`name`, $p1)')
    expect(prefix.bindings.p1).toBe('dedas')

    const suffix = compile({ name: { $like: '%dedas' } })
    expect(suffix.text).toContain('string::ends_with(`name`, $p1)')
    expect(suffix.bindings.p1).toBe('dedas')

    const exact = compile({ name: { $like: 'dedas' } })
    expect(exact.text).toContain('`name` = $p1')
    expect(exact.bindings.p1).toBe('dedas')
  })

  it('compiles inner wildcards to an anchored string::matches regex', () => {
    const out = compile({ name: { $like: 'd_da%s.x%' } })
    expect(out.text).toContain('string::matches(`name`, $p1)')
    // % → .*, _ → ., regex specials escaped, anchored both ends
    expect(out.bindings.p1).toBe(String.raw`^d.da.*s\.x.*$`)
  })

  it('keeps the ilike contract: string::lowercase on the column, lowercased term', () => {
    const contains = compile({ name: { $contains: 'DeDaS' } })
    expect(contains.text).toContain('string::contains(string::lowercase(`name`), $p1)')
    expect(contains.bindings.p1).toBe('dedas')

    const starts = compile({ name: { $startsWith: 'De' } })
    expect(starts.text).toContain('string::starts_with(string::lowercase(`name`), $p1)')
    expect(starts.bindings.p1).toBe('de')

    const ends = compile({ name: { $endsWith: 'aS' } })
    expect(ends.text).toContain('string::ends_with(string::lowercase(`name`), $p1)')
    expect(ends.bindings.p1).toBe('as')
  })

  it('flags the regex case-insensitive for an ilike pattern with inner wildcards', () => {
    const out = compile({ name: { $contains: 'a_b' } })
    expect(out.text).toContain('string::matches(`name`, $p1)')
    expect(out.bindings.p1).toBe('(?i)^.*a.b.*$')
  })

  it('leaves the IN rewrite and NOT composition intact around LIKE', () => {
    const out = compile({
      $and: [{ name: { $in: ['a', 'b'] } }, { $not: { slug: { $like: '%x%' } } }],
    })
    expect(out.text).toContain('IN [$p1, $p2]')
    expect(out.text).toContain('NOT (string::contains(`slug`, $p3))')
    expect(out.bindings.p3).toBe('x')
  })
})
