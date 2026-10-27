import { where } from 'client:core'

import { describe, expect, it } from 'bun:test'

// `where` builds the resource filter wire shape — the db's own algebra, field or json path first.

describe('client — where', () => {
  it('leaves, paths and the escaped prefix of startsWith', () => {
    expect(where.eq('agent', 'a1')).toEqual({ op: 'eq', field: 'agent', value: 'a1' })
    expect(where.ne('state', null)).toEqual({ op: 'ne', field: 'state', value: null })
    expect(where.gte(['payload', 'count'], 3)).toEqual({
      op: 'gte',
      field: 'payload',
      path: ['count'],
      value: 3,
    })
    expect(where.oneOf('state', ['a', 'b'])).toEqual({
      op: 'in',
      field: 'state',
      value: ['a', 'b'],
    })
    expect(where.notOneOf('state', ['a'])).toEqual({ op: 'not-in', field: 'state', value: ['a'] })
    expect(where.like('name', 'a%')).toEqual({ op: 'like', field: 'name', pattern: 'a%' })
    expect(where.ilike('name', 'a%')).toEqual({
      op: 'like',
      field: 'name',
      pattern: 'a%',
      insensitive: true,
    })
    expect(where.startsWith('name', '50%_off\\')).toEqual({
      op: 'like',
      field: 'name',
      pattern: String.raw`50\%\_off\\%`,
    })
    expect(where.startsWith('name', 'x', { insensitive: true })).toEqual({
      op: 'like',
      field: 'name',
      pattern: 'x%',
      insensitive: true,
    })
    expect(where.isNull('owner')).toEqual({ op: 'is-null', field: 'owner' })
    expect(where.notNull(['payload', 'at'])).toEqual({
      op: 'not-null',
      field: 'payload',
      path: ['at'],
    })
  })

  it('and / or / not compose', () => {
    const filter = where.and(
      where.eq('agent', 'a1'),
      where.or(where.eq('state', 'active'), where.not(where.isNull('state'))),
    )

    expect(filter).toEqual({
      op: 'and',
      filters: [
        { op: 'eq', field: 'agent', value: 'a1' },
        {
          op: 'or',
          filters: [
            { op: 'eq', field: 'state', value: 'active' },
            { op: 'not', filter: { op: 'is-null', field: 'state' } },
          ],
        },
      ],
    })
  })
})
