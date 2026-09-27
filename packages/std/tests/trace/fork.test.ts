import type { Task } from 'std:effect'
import { all, fork, run, sleep, spawn } from 'std:effect'
import { unwrap } from 'std:result'
import {
  ActiveSpan,
  current,
  enableTracing,
  isTracing,
  span,
  Suppressed,
  tracingState,
} from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { memoryTracer, traced } from './helpers'

describe('a span body shares ONE recorder with its forks', () => {
  it('setStatus / addEvent / updateName / setAttributes from a fork land on the span', async () => {
    const { tracer } = await traced(() =>
      span('handler', function* () {
        const task = yield* fork(function* () {
          const handle = yield* current()
          handle.setStatus({ code: 'error', message: 'from the fork' })
          handle.addEvent('forked')
          handle.updateName('renamed')
          handle.setAttributes({ 'ozaco.fork': true })
        })
        yield* task
      }),
    )

    const data = tracer.span('renamed')
    expect(data.status).toEqual({ code: 'error', message: 'from the fork' })
    expect(data.events.map(event => event.name)).toEqual(['forked'])
    expect(data.attributes).toEqual({ 'ozaco.fork': true })
  })

  it('spawned and all() members parent their spans to the same recorder', async () => {
    const { tracer } = await traced(() =>
      span('parent', function* () {
        const task = yield* spawn(() => span('spawned', function* () {}))
        yield* all([span('a', function* () {}), span('b', function* () {})])
        yield* task
      }),
    )

    const parent = tracer.span('parent').context.spanId
    for (const name of ['spawned', 'a', 'b']) {
      expect(tracer.span(name).parent?.spanId).toBe(parent)
    }
  })

  it('the active span is restored after the body, and a fork keeps it past the end', async () => {
    const { tracer, value } = await traced(function* () {
      let late: Task<string> | undefined

      const inner = yield* span('outer', function* (outer) {
        late = yield* spawn(function* () {
          yield* sleep(5)
          // the parent ended meanwhile: this span is an orphan of it, settled on its own
          return yield* span('late', function* () {
            return (yield* current()).context.traceId
          })
        })
        return outer.context
      })

      const after = yield* ActiveSpan.get()

      return { inner, after, late: yield* late! }
    })

    expect(value.after).toBeNull()
    expect(value.late).toBe(value.inner.traceId)
    expect(tracer.span('late').parent?.spanId).toBe(value.inner.spanId)
    expect(tracer.names()).toBe('outer, late')
  })
})

describe('Tracing is a LIVE context', () => {
  it('a fork created before tracing was enabled sees it (and a later flip)', async () => {
    const tracer = memoryTracer()

    const seen = unwrap(
      await run(function* () {
        // no TracingState anywhere yet: a snapshot context would leave the fork without one
        const task = yield* fork(function* () {
          yield* sleep(5)
          const on = yield* isTracing()
          yield* span('in-fork', function* () {})
          yield* sleep(5)
          return { on, off: yield* isTracing() }
        })

        yield* tracer.plugin.use()
        yield* sleep(7)

        const state = yield* tracingState()
        state!.enabled = false

        return yield* task
      }),
    )

    expect(seen).toEqual({ on: true, off: false })
    expect(tracer.span('in-fork').parent).toBeNull()
  })

  it('enableTracing in a child scope never flips the parent', async () => {
    const result = unwrap(
      await run(function* () {
        const outer = yield* enableTracing(true)

        const inner = yield* spawn(function* () {
          const own = yield* enableTracing(false)
          return { own, tracing: yield* isTracing() }
        })

        const child = yield* inner
        return {
          sameState: child.own === outer,
          childTracing: child.tracing,
          parentEnabled: outer.enabled,
          parentState: (yield* tracingState()) === outer,
        }
      }),
    )

    expect(result).toEqual({
      sameState: false,
      childTracing: false,
      parentEnabled: true,
      parentState: true,
    })
  })

  it('enableTracing pins ActiveSpan / Suppressed so later forks hold their own snapshot', async () => {
    const pinned = unwrap(
      await run(function* () {
        yield* enableTracing()
        return {
          active: yield* ActiveSpan.get(),
          suppressed: yield* Suppressed.get(),
        }
      }),
    )

    expect(pinned).toEqual({ active: null, suppressed: false })
  })

  it('no Tracer installed and no enableTracing ⇒ tracing is off', async () => {
    expect(unwrap(await run(() => isTracing()))).toBe(false)
    expect(unwrap(await run(() => tracingState()))).toBeUndefined()
  })
})
