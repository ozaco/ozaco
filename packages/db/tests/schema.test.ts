import { schemaFrom, tableSpecOf } from 'db:core'

import { describe, expect, it } from 'bun:test'

import { posts, users } from './helpers'

describe('schema DSL', () => {
  it('derives column specs from the column builders', () => {
    const byName = Object.fromEntries(users.columns.map(entry => [entry.name, entry]))
    expect(byName.name).toMatchObject({ kind: 'text', optional: false, hasDefault: false })
    expect(byName.age).toMatchObject({ kind: 'int', optional: true })
    expect(byName.role).toMatchObject({
      kind: 'enum',
      hasDefault: true,
      enumValues: ['admin', 'member'],
    })
    expect(byName.active).toMatchObject({ kind: 'boolean', hasDefault: true })
    expect(byName.meta).toMatchObject({ kind: 'json', optional: true })
    expect(byName.joined).toMatchObject({ kind: 'timestamp', optional: true })
  })

  it('brands reference columns with the target table', () => {
    const author = posts.columns.find(entry => entry.name === 'author')
    expect(author).toMatchObject({ kind: 'text', reference: 'users' })
  })

  it('collects default factories', () => {
    expect(users.defaults.role?.()).toBe('member')
    expect(users.defaults.active?.()).toBe(true)
    expect(users.defaults.name).toBeUndefined()
  })

  it('declares indexes fluently and immutably', () => {
    expect(users.indexes).toEqual([{ name: 'by_name', columns: ['name'], unique: true }])
    const extended = users.index('by_role', ['role'])
    expect(extended.indexes).toHaveLength(2)
    expect(users.indexes).toHaveLength(1)
  })

  it('builds adapter specs with the system columns first', () => {
    const spec = tableSpecOf(users)
    expect(spec.columns.slice(0, 4).map(entry => entry.name)).toEqual([
      '_id',
      '_createdAt',
      '_updatedAt',
      '_version',
    ])
    expect(spec.columns[0]).toMatchObject({ primary: true, system: true })
    expect(spec.columns.map(entry => entry.name)).toContain('name')
  })

  it('assembles schemas keyed by table name', () => {
    const schema = schemaFrom([users, posts])
    expect(Object.keys(schema.tables)).toEqual(['users', 'posts'])
  })
})
