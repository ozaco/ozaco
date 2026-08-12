import {
  all,
  allSettled,
  encapsulate,
  fork,
  race,
  run,
  scoped,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from 'std:effect'
import { isFailure, isSuccess, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('task value contract', () => {
  it('yield* and await agree on a spawned task value', async () => {
    // the canonical upstream contract: `yield* task` returns the value the task settled with,
    // exactly like awaiting its promise side does
    const awaited = await run(function* () {
      const task = yield* spawn(function* () {
        yield* sleep(1)
        return 'child'
      })
      return yield* task
    })

    expect(unwrap(awaited)).toBe('child')
  })
})

describe('structured concurrency: task trees', () => {
  it('unwinds each task before halting its own children when the root returns', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* spawn(function* () {
        yield* spawn(function* () {
          try {
            yield* suspend()
          } finally {
            order.push('grandchild')
          }
        })

        try {
          yield* suspend()
        } finally {
          order.push('child')
        }
      })

      yield* sleep(1)
      order.push('root')
      return 'done'
    })

    expect(unwrap(outcome)).toBe('done')
    // a halted task first unwinds its own generator (finally), THEN its scope halts its children
    expect(order).toEqual(['root', 'child', 'grandchild'])
  })

  it('escalates a grandchild failure through two levels and halts every sibling', async () => {
    const teardowns: string[] = []

    const outcome = await run(function* () {
      yield* spawn(function* () {
        yield* spawn(function* () {
          yield* sleep(1)
          throw new Error('grandchild boom')
        })
        try {
          yield* suspend()
        } finally {
          teardowns.push('middle')
        }
      })

      yield* spawn(function* () {
        try {
          yield* suspend()
        } finally {
          teardowns.push('sibling')
        }
      })

      yield* sleep(100)
      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    expect(teardowns).toContain('middle')
    expect(teardowns).toContain('sibling')
  })

  it('halt is idempotent and safe on an already-finished task', async () => {
    let teardowns = 0

    const pending = run(function* () {
      try {
        yield* suspend()
      } finally {
        teardowns++
      }
    })

    await pending.halt()
    await pending.halt()
    expect(teardowns).toBe(1)

    const finished = run(function* () {
      return 'ok'
    })
    expect(unwrap(await finished)).toBe('ok')
    await finished.halt()
    expect(unwrap(await finished)).toBe('ok')
  })

  it('yield* on a halted task raises `halted`', async () => {
    const outcome = await run(function* () {
      const task = yield* spawn(function* () {
        yield* suspend()
      })

      yield* task.halt()

      let raised: unknown
      try {
        yield* task
      } catch (error) {
        raised = error
      }

      return isFailure(raised) ? raised.error : 'no-error'
    })

    expect(unwrap(outcome)).toBe('halted')
  })

  it('a forked task is halted at the scoped() boundary and its teardown runs', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* scoped(function* () {
        yield* fork(function* () {
          try {
            yield* suspend()
          } finally {
            order.push('forked-teardown')
          }
        })
        order.push('scoped-body')
      })

      order.push('after-scoped')
      return order.slice()
    })

    expect(unwrap(outcome)).toEqual(['scoped-body', 'forked-teardown', 'after-scoped'])
  })

  it('encapsulate halts forked tasks at the boundary while the outer operation continues', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      const inner = yield* encapsulate(function* () {
        yield* fork(function* () {
          try {
            yield* suspend()
          } finally {
            order.push('encapsulated-teardown')
          }
        })
        return 'inner'
      })

      order.push('outer-continues')
      return inner
    })

    expect(unwrap(outcome)).toBe('inner')
    expect(order).toEqual(['encapsulated-teardown', 'outer-continues'])
  })
})

describe('spawn vs fork: start semantics', () => {
  it('spawn is best-effort (upstream parity): a suspension-free scope may close before the task starts', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* scoped(function* () {
        yield* spawn(function* () {
          order.push('started')
          try {
            yield* suspend()
          } finally {
            order.push('teardown')
          }
        })
        order.push('scoped-body')
      })

      return order.slice()
    })

    // the child never got a reducer step before the scope closed — body AND teardown never ran
    expect(unwrap(outcome)).toEqual(['scoped-body'])
    expect(order).toEqual(['scoped-body'])
  })

  it('fork has run the child to its first suspension point before it returns', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* fork(function* () {
        order.push('entered')
        yield* suspend()
      })

      order.push('after-fork')
      return order.slice()
    })

    expect(unwrap(outcome)).toEqual(['entered', 'after-fork'])
  })
})

describe('race', () => {
  it('a fast failure beats a slow success and the loser is torn down', async () => {
    let loserTeardown = false

    const outcome = await run(function* () {
      return yield* race([
        (function* () {
          yield* sleep(1)
          throw new Error('fast boom')
        })(),
        (function* () {
          try {
            yield* sleep(100)
          } finally {
            loserTeardown = true
          }
          return 'slow'
        })(),
      ])
    })

    expect(isFailure(outcome)).toBe(true)
    expect(loserTeardown).toBe(true)
  })

  it('nested races resolve inside-out', async () => {
    const outcome = await run(function* () {
      const inner = race([
        (function* () {
          yield* sleep(1)
          return 'inner-fast'
        })(),
        (function* () {
          yield* sleep(50)
          return 'inner-slow'
        })(),
      ])

      return yield* race([
        inner,
        (function* () {
          yield* sleep(100)
          return 'outer-slow'
        })(),
      ])
    })

    expect(unwrap(outcome)).toBe('inner-fast')
  })
})

describe('all / allSettled under load', () => {
  it('all preserves order across mixed timings and nested spawns', async () => {
    const outcome = await run(function* () {
      return yield* all([
        (function* () {
          yield* sleep(5)
          return 'a'
        })(),
        (function* () {
          yield* sleep(1)
          return 'b'
        })(),
        (function* () {
          return 'c'
        })(),
      ])
    })

    expect(unwrap(outcome)).toEqual(['a', 'b', 'c'])
  })

  it('one failing member halts the still-pending members', async () => {
    const teardowns: string[] = []

    const outcome = await run(function* () {
      return yield* all([
        (function* () {
          try {
            yield* suspend()
          } finally {
            teardowns.push('first')
          }
        })(),
        (function* () {
          yield* sleep(1)
          throw new Error('member boom')
        })(),
        (function* () {
          try {
            yield* suspend()
          } finally {
            teardowns.push('third')
          }
        })(),
      ])
    })

    expect(isFailure(outcome)).toBe(true)
    expect(teardowns).toContain('first')
    expect(teardowns).toContain('third')
  })

  it('allSettled isolates failures per member', async () => {
    const outcome = await run(function* () {
      const [good, bad, slow] = yield* allSettled([
        (function* () {
          return 'ok'
        })(),
        (function* () {
          throw new Error('boom')
          // oxlint-disable-next-line no-unreachable
          return 'never'
        })(),
        (function* () {
          yield* sleep(2)
          return 'slow-ok'
        })(),
      ])

      return {
        good: isSuccess(good) && good.value,
        bad: isFailure(bad),
        slow: isSuccess(slow) && slow.value,
      }
    })

    expect(unwrap(outcome)).toEqual({ good: 'ok', bad: true, slow: 'slow-ok' })
  })
})

describe('withResolvers', () => {
  it('the first settle wins; later settles are ignored', async () => {
    const outcome = await run(function* () {
      const gate = withResolvers<number>()
      gate.resolve(1)
      gate.resolve(2)
      gate.reject(new Error('late reject'))

      return yield* gate.operation
    })

    expect(unwrap(outcome)).toBe(1)
  })

  it('delivers the same outcome to every subscriber, early or late', async () => {
    const outcome = await run(function* () {
      const gate = withResolvers<string>()
      const early = withResolvers<string>()
      const late = withResolvers<string>()

      yield* spawn(function* () {
        early.resolve(yield* gate.operation)
      })

      yield* sleep(1)
      gate.resolve('settled')

      yield* spawn(function* () {
        late.resolve(yield* gate.operation)
      })

      return [yield* early.operation, yield* late.operation, yield* gate.operation]
    })

    expect(unwrap(outcome)).toEqual(['settled', 'settled', 'settled'])
  })

  it('reject raises at every yield site', async () => {
    const outcome = await run(function* () {
      const gate = withResolvers<string>()
      gate.reject(new Error('nope'))

      return yield* gate.operation
    })

    expect(isFailure(outcome)).toBe(true)
  })
})
