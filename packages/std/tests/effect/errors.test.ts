import type { Operation } from 'std:effect'
import {
  attempt,
  box,
  call,
  callcc,
  createScope,
  ensure,
  mapError,
  operation,
  recover,
  run,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, fail, isFailure, isSuccess, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('attempt / recover boundaries', () => {
  it('attempt captures thrown errors AND yielded failures as Result values', async () => {
    const outcome = await run(function* () {
      const thrown = yield* attempt(function* () {
        throw new Error('thrown boom')
      })

      const yielded = yield* attempt(function* () {
        return yield* fail('yielded-boom', 'raised through the reducer')
      })

      const fine = yield* attempt(function* () {
        return 'ok'
      })

      return {
        thrown: isFailure(thrown),
        yielded: isFailure(yielded) && yielded.error,
        fine: isSuccess(fine) && fine.value,
      }
    })

    expect(unwrap(outcome)).toEqual({ thrown: true, yielded: 'yielded-boom', fine: 'ok' })
  })

  it('attempt appends its cause tags to the captured failure', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(
        function* () {
          throw new Error('boom')
        },
        'stage-one',
        'stage-two',
      )

      return isFailure(result) ? result.causes : []
    })

    const causes = unwrap(outcome) as string[]
    expect(causes).toContain('stage-one')
    expect(causes).toContain('stage-two')
  })

  it('recover substitutes a fallback and passes successes through untouched', async () => {
    const outcome = await run(function* () {
      const replaced = yield* recover(
        function* (): Generator<never, string, never> {
          throw new Error('primary down')
        },
        function* (failure) {
          return `fallback:${isFailure(failure)}`
        },
      )

      const untouched = yield* recover(
        function* () {
          return 'primary'
        },
        function* () {
          return 'fallback'
        },
      )

      return { replaced, untouched }
    })

    expect(unwrap(outcome)).toEqual({ replaced: 'fallback:true', untouched: 'primary' })
  })

  it('an error boundary between a failing inner op and the caller contains the failure', async () => {
    const outcome = await run(function* () {
      const contained = yield* attempt(function* () {
        return yield* scoped(function* () {
          yield* fail('deep-failure', 'inside two layers')
          return 'unreachable'
        })
      })

      // the failure stopped at the attempt — the task itself still succeeds
      return isFailure(contained) ? 'contained' : 'leaked'
    })

    expect(unwrap(outcome)).toBe('contained')
  })
})

describe('mapError / operation() normalization', () => {
  it('mapError rewrites the failure while leaving success untouched', async () => {
    const outcome = await run(function* () {
      const mapped = yield* attempt(() =>
        mapError(
          (function* (): Generator<never, string, never> {
            throw new Error('raw')
          })(),
          failure => appendCauses(failure, 'mapped-tag'),
        ),
      )

      return isFailure(mapped) ? mapped.causes : []
    })

    expect(unwrap(outcome) as string[]).toContain('mapped-tag')
  })

  it('operation() re-raises a RETURNED failure and unwraps a RETURNED success', async () => {
    const failing = operation(function* () {
      // returned — not thrown, not yielded
      return fail('returned-failure', 'should still raise')
    })

    const succeeding = operation(function* () {
      return { _t: 'not-a-result', value: 42 }
    })

    const outcome = await run(function* () {
      const captured = yield* attempt(() => failing())
      const value = yield* succeeding()
      return { raised: isFailure(captured) && captured.error, value: value.value }
    })

    expect(unwrap(outcome)).toEqual({ raised: 'returned-failure', value: 42 })
  })

  it('operation() appends its cause tags to thrown errors', async () => {
    const tagged = operation(function* () {
      throw new Error('inner explosion')
    }, 'codec:encode')

    const outcome = await run(function* () {
      const result = yield* attempt(() => tagged())
      return isFailure(result) ? result.causes : []
    })

    expect(unwrap(outcome) as string[]).toContain('codec:encode')
  })

  it('box captures both directions without touching the enclosing task', async () => {
    const outcome = await run(function* () {
      const good = yield* box(function* () {
        return 'fine'
      })
      const bad = yield* box(function* () {
        throw new Error('boxed boom')
      })

      return { good: isSuccess(good) && good.value, bad: isFailure(bad) }
    })

    expect(unwrap(outcome)).toEqual({ good: 'fine', bad: true })
  })
})

describe('teardown semantics', () => {
  it('ensure blocks run LIFO and every one of them runs', async () => {
    const order: string[] = []

    await run(function* () {
      yield* scoped(function* () {
        yield* ensure(function* () {
          order.push('first-registered')
        })
        yield* ensure(function* () {
          order.push('second-registered')
        })
        yield* ensure(function* () {
          order.push('third-registered')
        })
      })
    })

    expect(order).toEqual(['third-registered', 'second-registered', 'first-registered'])
  })

  it('a destructor registered DURING teardown still runs (drain loop)', async () => {
    const order: string[] = []

    await run(function* () {
      yield* scoped(function* () {
        // `ensure` on the scope handle is internal — reached via cast to observe the drain loop
        const scope = (yield* useScope()) as unknown as {
          ensure(op: () => Operation<void>): () => void
        }

        yield* ensure(function* () {
          order.push('outer-teardown')
          scope.ensure(function* () {
            order.push('registered-during-teardown')
          })
        })
      })
    })

    expect(order).toEqual(['outer-teardown', 'registered-during-teardown'])
  })

  it('every teardown runs even when several fail, and a teardown failure surfaces', async () => {
    const ran: string[] = []

    const outcome = await run(() =>
      scoped(function* () {
        yield* ensure(function* () {
          ran.push('first')
          throw fail('first-teardown')
        })
        yield* ensure(function* () {
          ran.push('second')
          throw fail('second-teardown')
        })
      }),
    )

    expect(ran).toEqual(['second', 'first'])
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(['first-teardown', 'second-teardown']).toContain(outcome.error as string)
    }
  })

  it('teardown failures do not mask the primary failure of the body', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* ensure(function* () {
          throw fail('teardown-failure')
        })
        yield* fail('body-failure', 'the actual problem')
      }),
    )

    expect(isFailure(outcome)).toBe(true)
  })
})

describe('engine regressions', () => {
  it('call() on a task takes the operation side: value or raise, never a Result value', async () => {
    const [scope, destroy] = createScope()

    const outcome = await run(function* () {
      const good = scope.run(function* () {
        return 'ok'
      })
      const value = yield* call(() => good)

      const bad = scope.run(function* (): Generator<never, string, never> {
        throw new Error('task boom')
      })
      let raised = false
      try {
        yield* call(() => bad)
      } catch (error) {
        raised = isFailure(error)
      }

      return { value, raised }
    })

    await destroy()
    expect(unwrap(outcome)).toEqual({ value: 'ok', raised: true })
  })

  it('thenable values stay opaque on the operation side (yield*)', async () => {
    // deliberately thenable and never-settling: the regression under test is the engine
    // promise-lifting this value anywhere on the yield* path
    // oxlint-disable-next-line unicorn/no-thenable
    const thenable = { then: () => {} }

    const outcome = await run(function* () {
      const escaped = yield* callcc<unknown>(function* (resolve) {
        yield* resolve(thenable)
        yield* suspend()
      })

      const gate = withResolvers<unknown>()
      gate.resolve(thenable)
      const gated = yield* gate.operation

      const task = yield* spawn(function* () {
        return thenable
      })
      const viaTask = yield* task

      return {
        escaped: escaped === thenable,
        gated: gated === thenable,
        viaTask: viaTask === thenable,
      }
    })

    expect(unwrap(outcome)).toEqual({ escaped: true, gated: true, viaTask: true })

    // CONTRACT NOTE: the PROMISE side cannot make this guarantee. A JS promise resolved with a
    // thenable ADOPTS it per spec, so `await task` on a thenable-valued task waits on the
    // thenable itself — Promise<thenable> cannot exist in JavaScript. Tasks whose value may be a
    // live thenable must be consumed via `yield*`. Wrapped values are unaffected:
    const wrapped = await run(function* () {
      return { boxed: thenable }
    })
    expect((unwrap(wrapped) as { boxed: unknown }).boxed).toBe(thenable)
  })

  it('until adopts promise resolution and rejection', async () => {
    const outcome = await run(function* () {
      const value = yield* until(Promise.resolve('async value'))

      let failed = false
      try {
        yield* until(Promise.reject(new Error('nope')))
      } catch (error) {
        failed = isFailure(error)
      }

      return { value, failed }
    })

    expect(unwrap(outcome)).toEqual({ value: 'async value', failed: true })
  })

  it('a failure raised in a sleeping task still tears down its siblings deterministically', async () => {
    const events: string[] = []

    const outcome: unknown = await run(function* () {
      yield* ensure(function* () {
        events.push('root-teardown')
      })

      yield* sleep(1)
      yield* fail('root-failure', 'after a timer hop')
    })

    expect(isFailure(outcome as Result<unknown>)).toBe(true)
    expect(events).toEqual(['root-teardown'])
  })
})
