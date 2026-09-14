import { ensure, resource, run, scoped, sleep, spawn, suspend, useScope } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * AUDIT E40: `resource` (base/resource.ts) was never imported by any effect test. The header
 * promises "the resource task runs at the priority of its caller" — pinned here by ordering the
 * resource body against a task spawned in the same reducer pass (a plain child runs one priority
 * tier deeper than its parent, the resource does not). The rest pins the provide/teardown
 * lifecycle every scope-bound resource in std builds on.
 */
describe('resource priority', () => {
  it('two spawned siblings queued in the same pass run in FIFO order (baseline)', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* spawn(function* () {
        order.push('first')
      })
      yield* spawn(function* () {
        order.push('second')
      })

      yield* sleep(1)

      return order.slice()
    })

    expect(unwrap(outcome)).toEqual(['first', 'second'])
  })

  it('a resource body queued AFTER a spawned sibling still runs first: it shares the caller priority', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      yield* spawn(function* () {
        order.push('child')
      })

      yield* resource<void>(function* (provide) {
        order.push('resource')
        yield* provide()
      })

      yield* sleep(1)

      return order.slice()
    })

    // the spawned child is one tier deeper (caller + 1); the resource task is prioritized to the
    // caller's own tier, so the reducer picks it first even though it was enqueued second
    expect(unwrap(outcome)).toEqual(['resource', 'child'])
  })
})

describe('resource lifecycle', () => {
  it('provide() hands the value to the caller and suspends the body until the scope ends', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      const value = yield* scoped(function* () {
        const handle = yield* resource<string>(function* (provide) {
          order.push('setup')
          try {
            yield* provide('handle')
            order.push('unreachable: provide returned')
          } finally {
            order.push('teardown')
          }
        })

        order.push(`using:${handle}`)
        yield* sleep(1)
        order.push('done-using')

        return handle
      })

      order.push('after-scope')

      return value
    })

    expect(unwrap(outcome)).toBe('handle')
    expect(order).toEqual(['setup', 'using:handle', 'done-using', 'teardown', 'after-scope'])
  })

  it('resources are torn down in reverse acquisition order, before ensure() blocks registered earlier', async () => {
    const order: string[] = []

    await run(function* () {
      yield* scoped(function* () {
        yield* ensure(() => {
          order.push('ensure-first')
        })

        yield* resource<void>(function* (provide) {
          try {
            yield* provide()
          } finally {
            order.push('resource-a')
          }
        })

        yield* resource<void>(function* (provide) {
          try {
            yield* provide()
          } finally {
            order.push('resource-b')
          }
        })

        yield* ensure(() => {
          order.push('ensure-last')
        })
      })
    })

    expect(order).toEqual(['ensure-last', 'resource-b', 'resource-a', 'ensure-first'])
  })

  it('an effectful teardown is awaited before the scope finishes', async () => {
    const order: string[] = []

    await run(function* () {
      yield* scoped(function* () {
        yield* resource<void>(function* (provide) {
          try {
            yield* provide()
          } finally {
            order.push('teardown-start')
            yield* sleep(10)
            order.push('teardown-end')
          }
        })
      })

      order.push('after-scope')
    })

    expect(order).toEqual(['teardown-start', 'teardown-end', 'after-scope'])
  })

  it('a failure BEFORE provide() is raised at the acquisition site', async () => {
    const outcome = await run(function* () {
      let raised: unknown

      try {
        yield* resource<void>(function* () {
          yield* sleep(1)
          return yield* fail('resource.setup.boom')
        })
      } catch (error) {
        raised = error
      }

      return isFailure(raised) ? String(raised.error) : 'no-raise'
    })

    expect(unwrap(outcome)).toBe('resource.setup.boom')
  })

  it('a resource acquired by a task is torn down when that task is halted', async () => {
    const order: string[] = []

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        yield* resource<void>(function* (provide) {
          try {
            yield* provide()
          } finally {
            order.push('teardown')
          }
        })

        order.push('acquired')
        yield* suspend()
      })

      yield* sleep(1)
      expect(order).toEqual(['acquired'])

      yield* task.halt()

      order.push('halted')
    })

    expect(order).toEqual(['acquired', 'teardown', 'halted'])
  })
})
