/**
 * The shared module's declared shapes agree with the runtime, and its public surface is what the
 * barrel says: a private queue internal, an honest `deepMerge`, one flattener, `unknown`-typed
 * guards, an `exhaustive` that stays a function, and the builder's case shape under `Helpers`.
 */
import type { Helpers } from 'std:shared'
import {
  deepMerge,
  flatten,
  flattenEntries,
  isAsyncIterable,
  isNumber,
  match,
  PriorityQueue,
} from 'std:shared'

import { describe, expect, it } from 'bun:test'

interface Config {
  name: string
  nested: { a: number; b?: number }
}

describe('shared — declared shapes vs runtime', () => {
  it('the priority queue keeps its tiers to itself', () => {
    const queue = new PriorityQueue<string>()
    queue.push(1, 'low')
    // oxlint-disable-next-line unicorn/prefer-single-call -- a queue, not an array
    queue.push(0, 'high')

    // @ts-expect-error — `tiers` is private; the public surface is push/pop/min/max
    expect(Array.isArray(queue.tiers)).toBe(true)
    expect(queue.pop()).toBe('high')
    expect(queue.pop()).toBe('low')
    expect(queue.pop()).toBeUndefined()
  })

  it('deepMerge is a full T only when a full T went in', () => {
    const full: Config = deepMerge<Config>({ name: 'base', nested: { a: 1 } }, { name: 'over' })
    expect(full).toEqual({ name: 'over', nested: { a: 1 } })

    const partial: Partial<Config> = deepMerge<Config>({ nested: { a: 1 } }, { name: 'over' })
    expect(partial).toEqual({ name: 'over', nested: { a: 1 } })

    // @ts-expect-error — partials alone never promise a full Config
    const lie: Config = deepMerge<Config>({ nested: { a: 1 } }, undefined)
    expect(lie.name).toBeUndefined()
  })

  it('flatten is the object form of flattenEntries — one traversal, one set of leaves', () => {
    const fn = () => 1
    const tree = { a: { b: 1, c: { d: [1, 2] } }, e: 'x', f: fn, g: null }

    const flat = flatten(tree)
    expect(flat).toEqual({ 'a.b': 1, 'a.c.d': [1, 2], e: 'x', f: fn, g: null })
    expect(flat).toEqual(
      Object.fromEntries(flattenEntries(tree).map(entry => [entry.key, entry.value])),
    )
    expect(flatten(tree, 'root')['root.a.b']).toBe(1)
  })

  it('every guard takes `unknown` — an untyped value narrows without a cast', async () => {
    const value: unknown = (async function* () {
      yield 1
    })()

    expect(isAsyncIterable(value)).toBe(true)
    if (isAsyncIterable(value)) {
      const seen: unknown[] = []
      for await (const item of value) {
        seen.push(item)
      }
      expect(seen).toEqual([1])
    }
    expect(isAsyncIterable(null)).toBe(false)
    expect(isAsyncIterable({})).toBe(false)
    expect(isNumber(1)).toBe(true)
  })

  it('exhaustive stays a function — callable with no argument once every case is covered', () => {
    type Shape = 'circle' | 'square'
    const covered = match('circle' as Shape)
      .when(
        (value): value is 'circle' => value === 'circle',
        () => 'round',
      )
      .when(
        (value): value is 'square' => value === 'square',
        () => 'boxy',
      )
    expect(covered.exhaustive()).toBe('round')

    const partial = match('square' as Shape).when(
      (value): value is 'circle' => value === 'circle',
      () => 'round',
    )
    // @ts-expect-error — a case is missing: the signature demands the unhandled remainder
    expect(() => partial.exhaustive()).toThrow()
    // it is still a real function at runtime, not a Failure value
    expect(typeof partial.exhaustive).toBe('function')
  })

  it('MatchCase lives under Helpers; the builder type is the public one', () => {
    const recorded: Helpers.MatchCase = { handler: value => value, predicate: () => true }
    expect(typeof recorded.handler).toBe('function')
  })
})
