import type { AnyType } from 'std:shared'
import { deepMerge, flatten, flattenEntries, getPath, setPath, unsetPath } from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('flatten', () => {
  it('flattens nested objects to dotted keys; functions and arrays stay leaves', () => {
    const handler = () => 'ok'
    const list = [1, 2]

    const flat = flatten({ top: 1, nest: { deep: { leaf: 'x' }, fn: handler }, list })

    expect(flat).toEqual({ top: 1, 'nest.deep.leaf': 'x', 'nest.fn': handler, list })
    expect(flat.list).toBe(list)
    expect(flatten({})).toEqual({})
  })
})

describe('deepMerge', () => {
  it('merges nested objects, later sources win, arrays replace wholesale', () => {
    const replacement = [3]
    const merged = deepMerge<Record<string, AnyType>>(
      { keep: 'a', nested: { deep: 1, stay: true }, list: [1, 2] },
      undefined,
      { nested: { deep: 2 }, list: replacement, added: 'new' },
    )

    expect(merged).toEqual({
      keep: 'a',
      nested: { deep: 2, stay: true },
      list: replacement,
      added: 'new',
    })
    expect(merged.list).toBe(replacement) // arrays are shared by reference
  })

  it('undefined never overrides; sources are never mutated or aliased', () => {
    const base = { nested: { keep: 1 }, flag: true }
    const merged = deepMerge<Record<string, AnyType>>(base, { flag: undefined, nested: {} })

    expect(merged).toEqual({ nested: { keep: 1 }, flag: true })

    merged.nested.keep = 99
    expect(base.nested.keep).toBe(1)
  })
})

describe('path helpers', () => {
  const source: Record<string, AnyType> = { a: { b: { c: 42 } }, list: [1, 2] }

  it('getPath reads dotted keys and misses safely', () => {
    expect(getPath<number>(source, 'a.b.c')).toBe(42)
    expect(getPath<number>(source, 'a..b.c')).toBe(42) // empty segments are dropped
    expect(getPath(source, 'a.missing.c')).toBeUndefined()
    expect(getPath(source, 'list.0')).toBeUndefined() // arrays are not traversed
  })

  it('setPath writes immutably, cloning only along the touched path', () => {
    const original: Record<string, AnyType> = { keep: true, nested: { deep: 1 } }
    const updated = setPath(original, 'nested.added.leaf', 'x')

    expect(updated).toEqual({ keep: true, nested: { deep: 1, added: { leaf: 'x' } } })
    expect(original).toEqual({ keep: true, nested: { deep: 1 } })
    expect(updated.nested).not.toBe(original.nested)

    expect(setPath(original, '', 'x')).toBe(original) // empty path is identity
  })

  it('unsetPath removes a leaf on a fresh copy; absent paths are a no-op copy', () => {
    const original: Record<string, AnyType> = { a: { b: 1, keep: 2 } }

    const removed = unsetPath(original, 'a.b')
    expect(removed).toEqual({ a: { keep: 2 } })
    expect(original.a.b).toBe(1)

    const untouched = unsetPath(original, 'missing.leaf')
    expect(untouched).toEqual(original)
    expect(untouched).not.toBe(original)
  })
})

describe('flattenEntries', () => {
  it('lists leaf entries with dotted keys, arrays and null as leaf values', () => {
    const entries = flattenEntries({ a: { b: 1 }, list: [1], empty: null })

    expect(entries).toEqual([
      { key: 'a.b', value: 1 },
      { key: 'list', value: [1] },
      { key: 'empty', value: null },
    ])
  })
})
