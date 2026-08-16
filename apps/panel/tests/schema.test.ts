import { describe, expect, test } from 'bun:test'

import { schemaTypeLabel, skeletonOf, walkSchema } from '../src/lib/schema'

describe('schemaTypeLabel', () => {
  test('labels primitives, enums, consts and unions', () => {
    expect(schemaTypeLabel({ type: 'string' })).toBe('string')
    expect(schemaTypeLabel({ enum: ['a', 'b'] })).toBe('"a" | "b"')
    expect(schemaTypeLabel({ const: 'watch' })).toBe('"watch"')
    expect(schemaTypeLabel({ anyOf: [{ type: 'string' }] })).toBe('anyOf')
    expect(schemaTypeLabel({ type: ['string', 'null'] })).toBe('string | null')
    expect(schemaTypeLabel({})).toBe('any')
    expect(schemaTypeLabel(undefined)).toBe('any')
  })
})

describe('walkSchema', () => {
  test('resolves object properties with required flags', () => {
    const node = walkSchema({
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: 'optional note' },
      },
      required: ['id'],
    })

    expect(node.type).toBe('object')
    expect(node.children).toHaveLength(2)
    expect(node.children[0]).toMatchObject({ name: 'id', type: 'string', required: true })
    expect(node.children[1]).toMatchObject({
      name: 'note',
      required: false,
      description: 'optional note',
    })
  })

  test('resolves array items and anyOf variants', () => {
    const array = walkSchema({ type: 'array', items: { type: 'number' } })

    expect(array.children[0]).toMatchObject({ name: 'items', type: 'number' })

    const union = walkSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })

    expect(union.children.map(child => child.name)).toEqual(['#0', '#1'])
  })

  test('tolerates opaque declared markers and junk', () => {
    expect(walkSchema({ declared: true })).toMatchObject({ type: 'declared', declared: true })
    expect(walkSchema('junk')).toMatchObject({ type: 'any', children: [] })
  })
})

describe('skeletonOf', () => {
  test('objects carry required keys only, with sensible primitives', () => {
    expect(
      skeletonOf({
        type: 'object',
        properties: {
          title: { type: 'string' },
          count: { type: 'integer' },
          done: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['title', 'count', 'done'],
      }),
    ).toEqual({ title: '', count: 0, done: false })
  })

  test('nested required objects recurse', () => {
    expect(
      skeletonOf({
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
        },
        required: ['filter'],
      }),
    ).toEqual({ filter: { done: false } })
  })

  test('default, const, first enum member and first anyOf variant win', () => {
    expect(skeletonOf({ type: 'number', default: 5 })).toBe(5)
    expect(skeletonOf({ const: 'watch' })).toBe('watch')
    expect(skeletonOf({ enum: ['open', 'closed'] })).toBe('open')
    expect(skeletonOf({ anyOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0)
  })

  test('arrays, nulls and opaque schemas', () => {
    expect(skeletonOf({ type: 'array', items: { type: 'string' } })).toEqual([])
    expect(skeletonOf({ type: 'null' })).toBeNull()
    expect(skeletonOf({ declared: true })).toEqual({})
    expect(skeletonOf(undefined)).toEqual({})
  })

  test('typeless schemas with properties are treated as objects', () => {
    expect(skeletonOf({ properties: { id: { type: 'string' } }, required: ['id'] })).toEqual({
      id: '',
    })
  })
})
