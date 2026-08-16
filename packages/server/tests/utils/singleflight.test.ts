import { createSingleflight } from 'server:utils'
import type { Operation } from 'std:effect'
import { attempt, sleep, spawn } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

describe('createSingleflight', () => {
  it('shares one execution among concurrent callers', async () => {
    let calls = 0
    const flight = createSingleflight<string>()

    const [first, second, sizeDuring] = await runScoped(function* () {
      const op = function* (): Operation<string> {
        calls += 1
        yield* sleep(20)
        return 'value'
      }

      const one = yield* spawn(() => flight.run('key', op))
      const two = yield* spawn(() => flight.run('key', op))

      yield* sleep(5)
      const during = flight.size()

      return [yield* one, yield* two, during] as const
    })

    expect(first).toBe('value')
    expect(second).toBe('value')
    expect(sizeDuring).toBe(1)
    expect(calls).toBe(1)
    expect(flight.size()).toBe(0)
  })

  it('propagates the shared failure to every joiner', async () => {
    let calls = 0
    const flight = createSingleflight<string>()

    const [one, two] = await runScoped(function* () {
      const op = function* (): Operation<string> {
        calls += 1
        yield* sleep(10)
        return yield* fail('exploded', 'shared failure')
      }

      const first = yield* spawn(() => attempt(flight.run('boom', op)))
      const second = yield* spawn(() => attempt(flight.run('boom', op)))

      return [yield* first, yield* second] as const
    })

    expect(isFailure(one)).toBe(true)
    expect(isFailure(two)).toBe(true)
    if (isFailure(one) && isFailure(two)) {
      expect(one.error).toBe('exploded')
      expect(two.error).toBe('exploded')
    }
    expect(calls).toBe(1)
    expect(flight.size()).toBe(0)
  })

  it('runs sequential calls independently once settled', async () => {
    let calls = 0
    const flight = createSingleflight<number>()

    const [first, second] = await runScoped(function* () {
      const op = function* (): Operation<number> {
        calls += 1
        return calls
      }

      return [yield* flight.run('key', op), yield* flight.run('key', op)] as const
    })

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(calls).toBe(2)
  })

  it('isolates different keys', async () => {
    let calls = 0
    const flight = createSingleflight<string>()

    const [alpha, beta] = await runScoped(function* () {
      const op = (name: string) =>
        function* (): Operation<string> {
          calls += 1
          yield* sleep(10)
          return name
        }

      const one = yield* spawn(() => flight.run('a', op('alpha')))
      const two = yield* spawn(() => flight.run('b', op('beta')))

      return [yield* one, yield* two] as const
    })

    expect(alpha).toBe('alpha')
    expect(beta).toBe('beta')
    expect(calls).toBe(2)
  })
})
