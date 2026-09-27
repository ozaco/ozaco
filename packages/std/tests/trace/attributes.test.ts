import { fail } from 'std:result'
import { toAttributes } from 'std:trace'

import { describe, expect, it } from 'bun:test'

describe('toAttributes', () => {
  it('primitives stay, null / undefined / functions drop, the rest becomes text', () => {
    const { attributes, dropped } = toAttributes({
      text: 'a',
      count: 1.5,
      yes: false,
      none: null,
      missing: undefined,
      call: () => 1,
      id: 9_007_199_254_740_993n,
      tag: Symbol('s'),
      error: new RangeError('too far'),
      failure: fail('app.x', 'broken', 'step'),
      invalid: new Date(Number.NaN),
      '': 'no key',
    })

    expect(dropped).toBe(0)
    expect(attributes).toEqual({
      text: 'a',
      count: 1.5,
      yes: false,
      id: '9007199254740993',
      tag: 'Symbol(s)',
      error: 'RangeError: too far',
      failure: 'app.x: broken: step',
      invalid: 'Invalid Date',
    })
  })

  it('non-finite numbers become their strings wherever they sit — every sink holds the same', () => {
    const { attributes } = toAttributes({
      nan: Number.NaN,
      max: Number.POSITIVE_INFINITY,
      min: Number.NEGATIVE_INFINITY,
      zero: -0,
      big: Number.MAX_VALUE,
      finite: [1, 2.5, -0],
      mixed: [1, Number.NaN, Number.NEGATIVE_INFINITY],
      primitives: [true, Number.POSITIVE_INFINITY],
      nested: { ratio: 0 / 0 },
      rows: [{ ratio: Number.NaN, max: Number.POSITIVE_INFINITY }],
      deep: { a: { b: { c: { min: Number.NEGATIVE_INFINITY } } } },
    })

    expect(attributes).toEqual({
      nan: 'NaN',
      max: 'Infinity',
      min: '-Infinity',
      // -0 loses its sign (JSON writes it `0`; protobuf would keep it)
      zero: 0,
      big: Number.MAX_VALUE,
      finite: [1, 2.5, 0],
      // one non-finite member: the array stays homogeneous — strings
      mixed: ['1', 'NaN', '-Infinity'],
      primitives: ['true', 'Infinity'],
      'nested.ratio': 'NaN',
      // inside JSON text too: `"NaN"`, never JSON's lossy `null`
      rows: '[{"ratio":"NaN","max":"Infinity"}]',
      'deep.a.b.c': '{"min":"-Infinity"}',
    })
    // what a sink serializes is what it stored: a JSON round trip changes nothing
    expect(Object.is(attributes.zero, 0)).toBe(true)
    expect(Object.is((attributes.finite as readonly number[])[2], 0)).toBe(true)
    const json = JSON.stringify(attributes)
    expect(JSON.parse(json)).toEqual(attributes)
  })

  it('plain objects flatten 3 levels deep, class instances and cycles become JSON', () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }

    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic

    const { attributes } = toAttributes({
      a: { b: { c: { d: { e: 1 } }, flat: 'x' } },
      point: new Point(1, 2),
      cyclic: { inner: { deeper: { deepest: cyclic } } },
      map: new Map([['k', 1]]),
      nested: [[1, 2]],
      empty: {},
    })

    expect(attributes).toEqual({
      'a.b.c.d': '{"e":1}',
      'a.b.flat': 'x',
      point: '{"x":1,"y":2}',
      'cyclic.inner.deeper.deepest': '{"a":1,"self":"[Circular]"}',
      map: '{}',
      nested: '[[1,2]]',
    })
  })

  it('keys are never transformed, and __proto__ stays an own key', () => {
    const input = JSON.parse('{"__proto__": 1, "Mixed.Case Key": 2}') as Record<string, unknown>
    const { attributes } = toAttributes(input)

    expect(Object.keys(attributes)).toEqual(['__proto__', 'Mixed.Case Key'])
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype)
  })

  it('maxBytes and maxCount options', () => {
    const { attributes, dropped } = toAttributes(
      { a: 'x'.repeat(100), b: 1, c: 2 },
      { maxBytes: 10, maxCount: 2 },
    )

    expect(attributes).toEqual({ a: 'xxxxxxx…', b: 1 })
    expect(dropped).toBe(1)
  })

  it('strings are cut on a code-point boundary', () => {
    const { attributes } = toAttributes({ emoji: '😀'.repeat(10) }, { maxBytes: 10 })
    // 4-byte emoji: one fits before the 3-byte ellipsis within 10 bytes
    expect(attributes.emoji).toBe('😀…')
  })
})
