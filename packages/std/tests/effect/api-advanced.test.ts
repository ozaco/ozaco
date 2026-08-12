import type { Operation } from 'std:effect'
import { createApi, run, scoped, sleep, spawn, withResolvers } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface MathApi {
  add(a: number, b: number): Operation<number>
  base: number
}

const makeMath = (name: string) =>
  createApi<MathApi>(name, {
    *add(a, b) {
      return a + b
    },
    base: 100,
  })

describe('api decoration ordering', () => {
  it('layers call in order: max chain (install order) → min chain (reverse) → core', async () => {
    const Math_ = makeMath('math.ordering')
    const trace: string[] = []

    const layer = (label: string) => ({
      add: ([a, b]: [number, number], next: (a: number, b: number) => Operation<number>) =>
        (function* () {
          trace.push(`in:${label}`)
          const result = yield* next(a, b)
          trace.push(`out:${label}`)
          return result
        })(),
    })

    const outcome = await run(function* () {
      return yield* scoped(function* () {
        yield* Math_.around(layer('maxA'), { at: 'max' })
        yield* Math_.around(layer('maxB'), { at: 'max' })
        yield* Math_.around(layer('minC'), { at: 'min' })
        yield* Math_.around(layer('minD'), { at: 'min' })

        return yield* Math_.actions.add(1, 2)
      })
    })

    expect(unwrap(outcome)).toBe(3)
    expect(trace).toEqual([
      'in:maxA',
      'in:maxB',
      'in:minD',
      'in:minC',
      'out:minC',
      'out:minD',
      'out:maxB',
      'out:maxA',
    ])
  })

  it('decorates value members through the same middleware chain', async () => {
    const Math_ = makeMath('math.value-member')

    const outcome = await run(function* () {
      const decorated = yield* scoped(function* () {
        yield* Math_.around({
          base: (_args, next) => (next() as number) * 2,
        })
        return yield* Math_.actions.base
      })

      const plain = yield* Math_.actions.base

      return { decorated, plain }
    })

    expect(unwrap(outcome)).toEqual({ decorated: 200, plain: 100 })
  })
})

describe('api decoration propagation across live scopes', () => {
  it('a decoration installed AFTER a child task started still reaches the child', async () => {
    const Math_ = makeMath('math.late-decoration')

    const outcome = await run(function* () {
      const gate = withResolvers<void>('decoration installed')
      const result = withResolvers<number>('decorated result')

      yield* spawn(function* () {
        yield* gate.operation
        // by now the parent has decorated — the child scope must see it
        result.resolve(yield* Math_.actions.add(1, 1))
      })

      yield* Math_.around({
        add: ([a, b], next) =>
          (function* () {
            return (yield* next(a, b)) + 1000
          })(),
      })

      gate.resolve()
      return yield* result.operation
    })

    expect(unwrap(outcome)).toBe(1002)
  })

  it('a child-scope decoration never leaks to the parent or to a sibling', async () => {
    const Math_ = makeMath('math.leak-check')

    const outcome = await run(function* () {
      const decorated = yield* scoped(function* () {
        yield* Math_.around({
          add: ([a, b], next) =>
            (function* () {
              return (yield* next(a, b)) * -1
            })(),
        })
        return yield* Math_.actions.add(2, 3)
      })

      const sibling = yield* scoped(function* () {
        return yield* Math_.actions.add(2, 3)
      })

      const parent = yield* Math_.actions.add(2, 3)

      return { decorated, sibling, parent }
    })

    expect(unwrap(outcome)).toEqual({ decorated: -5, sibling: 5, parent: 5 })
  })

  it('nested scopes stack decorations: inner sees inner+outer, outer sees only outer', async () => {
    const Math_ = makeMath('math.stacked')
    const trace: string[] = []

    const layer = (label: string) => ({
      add: ([a, b]: [number, number], next: (a: number, b: number) => Operation<number>) =>
        (function* () {
          trace.push(label)
          return yield* next(a, b)
        })(),
    })

    const outcome = await run(function* () {
      return yield* scoped(function* () {
        yield* Math_.around(layer('outer'))

        const inner = yield* scoped(function* () {
          yield* Math_.around(layer('inner'))
          return yield* Math_.actions.add(1, 1)
        })

        trace.push('--')
        const outerOnly = yield* Math_.actions.add(1, 1)

        return { inner, outerOnly }
      })
    })

    expect(unwrap(outcome)).toEqual({ inner: 2, outerOnly: 2 })
    expect(trace).toEqual(['outer', 'inner', '--', 'outer'])
  })

  it('a decoration keeps applying to concurrent invocations without cross-talk', async () => {
    const Math_ = makeMath('math.concurrent')

    const outcome = await run(function* () {
      return yield* scoped(function* () {
        yield* Math_.around({
          add: ([a, b], next) =>
            (function* () {
              yield* sleep(1)
              return yield* next(a, b)
            })(),
        })

        const first = withResolvers<number>()
        const second = withResolvers<number>()

        yield* spawn(function* () {
          first.resolve(yield* Math_.actions.add(1, 2))
        })
        yield* spawn(function* () {
          second.resolve(yield* Math_.actions.add(10, 20))
        })

        return [yield* first.operation, yield* second.operation]
      })
    })

    expect(unwrap(outcome)).toEqual([3, 30])
  })
})
