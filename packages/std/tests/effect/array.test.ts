import {
  attempt,
  filter,
  filterPar,
  map,
  mapPar,
  reduce,
  run,
  sleep,
  some,
  toSorted,
} from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * The effectful array helpers (`map/mapPar/some/filter/filterPar/reduce/toSorted`), used by logger
 * and codec in production. Pins: result ORDER always
 * follows the input, the sequential helpers run one item at a time (and short-circuit where they
 * should), the `*Par` helpers run every item concurrently through `all` and inherit its
 * fail-fast + halt-the-rest semantics.
 */

/** Records `start:i` / `end:i` around an effectful step that sleeps `ms`. */
const traced = (log: string[], ms: number) =>
  function* (value: number, index: number) {
    log.push(`start:${index}`)
    yield* sleep(ms)
    log.push(`end:${index}`)
    return value * 2
  }

describe('map (sequential)', () => {
  it('maps in input order, one item at a time, passing the index', async () => {
    const log: string[] = []

    const outcome = await run(function* () {
      return yield* map([1, 2, 3], traced(log, 1))
    })

    expect(unwrap(outcome)).toEqual([2, 4, 6])
    expect(log).toEqual(['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2'])
  })

  it('maps an empty array to an empty array without calling the mapper', async () => {
    let calls = 0

    const outcome = await run(function* () {
      return yield* map([], function* () {
        calls++
        return 1
      })
    })

    expect(unwrap(outcome)).toEqual([])
    expect(calls).toBe(0)
  })

  it('a failing mapper stops the iteration and propagates the failure', async () => {
    let calls = 0

    const outcome = await run(function* () {
      return yield* map([1, 2, 3], function* (value) {
        calls++
        if (value === 2) {
          return yield* fail('map.boom')
        }
        return value
      })
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('map.boom')
    }
    expect(calls).toBe(2)
  })
})

describe('mapPar (parallel via all)', () => {
  it('runs every mapper concurrently and still returns results in input order', async () => {
    const log: string[] = []

    const outcome = await run(function* () {
      // the slowest item is FIRST: sequential execution would finish 0 before starting 1
      return yield* mapPar([30, 15, 1], function* (ms, index) {
        log.push(`start:${index}`)
        yield* sleep(ms)
        log.push(`end:${index}`)
        return `item-${index}`
      })
    })

    expect(unwrap(outcome)).toEqual(['item-0', 'item-1', 'item-2'])
    // every mapper started before any finished, and they finished fastest-first
    expect(log.slice(0, 3)).toEqual(['start:0', 'start:1', 'start:2'])
    expect(log.slice(3)).toEqual(['end:2', 'end:1', 'end:0'])
  })

  it('a failing mapper fails the whole map and halts the siblings still running', async () => {
    const teardowns: string[] = []

    const outcome = await run(function* () {
      return yield* mapPar([1, 2, 3], function* (value) {
        if (value === 2) {
          yield* sleep(1)
          return yield* fail('mapPar.boom')
        }
        try {
          yield* sleep(200)
        } finally {
          teardowns.push(`halted:${value}`)
        }
        return value
      })
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('mapPar.boom')
    }
    expect(teardowns.toSorted()).toEqual(['halted:1', 'halted:3'])
  })

  it('maps an empty array to an empty array', async () => {
    const outcome = await run(function* () {
      return yield* mapPar([], function* () {
        return 1
      })
    })

    expect(unwrap(outcome)).toEqual([])
  })
})

describe('some', () => {
  it('short-circuits on the first true predicate', async () => {
    const tested: number[] = []

    const outcome = await run(function* () {
      return yield* some([1, 2, 3, 4], function* (value) {
        tested.push(value)
        yield* sleep(1)
        return value === 2
      })
    })

    expect(unwrap(outcome)).toBe(true)
    expect(tested).toEqual([1, 2])
  })

  it('returns false after testing every item when none matches', async () => {
    const tested: number[] = []

    const outcome = await run(function* () {
      return yield* some([1, 2, 3], function* (value, index) {
        tested.push(index)
        return value > 10
      })
    })

    expect(unwrap(outcome)).toBe(false)
    expect(tested).toEqual([0, 1, 2])
  })

  it('returns false for an empty array', async () => {
    const outcome = await run(function* () {
      return yield* some([], function* () {
        return true
      })
    })

    expect(unwrap(outcome)).toBe(false)
  })
})

describe('filter (sequential)', () => {
  it('keeps the matching items in input order, testing one at a time', async () => {
    const log: string[] = []

    const outcome = await run(function* () {
      return yield* filter([5, 6, 7, 8], function* (value, index) {
        log.push(`start:${index}`)
        yield* sleep(1)
        log.push(`end:${index}`)
        return value % 2 === 0
      })
    })

    expect(unwrap(outcome)).toEqual([6, 8])
    expect(log).toEqual([
      'start:0',
      'end:0',
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ])
  })
})

describe('filterPar (parallel via all)', () => {
  it('tests every item concurrently and keeps the input order', async () => {
    const log: string[] = []

    const outcome = await run(function* () {
      return yield* filterPar([30, 15, 1, 20], function* (ms, index) {
        log.push(`start:${index}`)
        yield* sleep(ms)
        return index !== 1
      })
    })

    expect(unwrap(outcome)).toEqual([30, 1, 20])
    expect(log).toEqual(['start:0', 'start:1', 'start:2', 'start:3'])
  })

  it('a failing predicate fails the filter', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(
        filterPar([1, 2], function* (value) {
          if (value === 2) {
            return yield* fail('filterPar.boom')
          }
          return true
        }),
      )

      return isFailure(result) ? String(result.error) : 'no-fail'
    })

    expect(unwrap(outcome)).toBe('filterPar.boom')
  })
})

describe('reduce', () => {
  it('folds left to right with the accumulator and index', async () => {
    const seen: string[] = []

    const outcome = await run(function* () {
      return yield* reduce(
        ['a', 'b', 'c'],
        function* (acc, value, index) {
          seen.push(`${index}:${acc}`)
          yield* sleep(1)
          return acc + value
        },
        '',
      )
    })

    expect(unwrap(outcome)).toBe('abc')
    expect(seen).toEqual(['0:', '1:a', '2:ab'])
  })

  it('returns the initial value for an empty array', async () => {
    const outcome = await run(function* () {
      return yield* reduce(
        [] as number[],
        function* (acc, value) {
          return acc + value
        },
        42,
      )
    })

    expect(unwrap(outcome)).toBe(42)
  })
})

describe('toSorted (effectful comparator)', () => {
  it('sorts with a suspending comparator and leaves the input untouched', async () => {
    const input = [3, 1, 2, 5, 4]
    let comparisons = 0

    const outcome = await run(function* () {
      return yield* toSorted(input, function* (a, b) {
        comparisons++
        yield* sleep(0)
        return a - b
      })
    })

    expect(unwrap(outcome)).toEqual([1, 2, 3, 4, 5])
    expect(input).toEqual([3, 1, 2, 5, 4])
    expect(comparisons).toBeGreaterThan(0)
  })

  it('is stable: equal keys keep their input order', async () => {
    const input = [
      { key: 1, tag: 'a' },
      { key: 0, tag: 'b' },
      { key: 1, tag: 'c' },
      { key: 0, tag: 'd' },
    ]

    const outcome = await run(function* () {
      return yield* toSorted(input, function* (a, b) {
        return a.key - b.key
      })
    })

    expect(unwrap(outcome).map(item => item.tag)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('a failing comparator fails the sort', async () => {
    const outcome = await run(function* () {
      return yield* toSorted([2, 1], function* () {
        return yield* fail('sort.boom')
      })
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('sort.boom')
    }
  })

  it('handles empty and single-element arrays without comparing', async () => {
    let comparisons = 0

    const outcome = await run(function* () {
      const compare = function* () {
        comparisons++
        return 0
      }
      const empty = yield* toSorted([], compare)
      const single = yield* toSorted([1], compare)
      return { empty, single }
    })

    expect(unwrap(outcome)).toEqual({ empty: [], single: [1] })
    expect(comparisons).toBe(0)
  })
})
