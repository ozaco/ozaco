import type { Task } from 'std:effect'
import { all, fork, run, sleep, spawn, useScope } from 'std:effect'
import { unwrap } from 'std:result'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { ActiveSpan, Suppressed, Tracing } from '../../src/trace/internal/context'

import { memoryTracer, traced } from './helpers'

describe('a span body shares ONE recorder with its forks', () => {
  it('setStatus / addEvent / updateName / setAttributes from a fork land on the span', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('handler', function* () {
        const task = yield* fork(function* () {
          const handle = yield* Trace.actions.current()

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
      Trace.actions.span('parent', function* () {
        const task = yield* spawn(() => Trace.actions.span('spawned', function* () {}))

        yield* all([
          Trace.actions.span('a', function* () {}),
          Trace.actions.span('b', function* () {}),
        ])
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

      const inner = yield* Trace.actions.span('outer', function* (outer) {
        late = yield* spawn(function* () {
          yield* sleep(5)

          // the parent ended meanwhile: this span is an orphan of it, settled on its own
          return yield* Trace.actions.span('late', function* () {
            return (yield* Trace.actions.current()).context.traceId
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

          const on = yield* Trace.actions.isTracing()

          yield* Trace.actions.span('in-fork', function* () {})
          yield* sleep(5)

          return { on, off: yield* Trace.actions.isTracing() }
        })

        yield* tracer.plugin.use()
        yield* sleep(7)

        const state = (yield* useScope()).get(Tracing)

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
        const outer = yield* Trace.actions.enableTracing(true)

        const inner = yield* spawn(function* () {
          const own = yield* Trace.actions.enableTracing(false)

          return { own, tracing: yield* Trace.actions.isTracing() }
        })

        const child = yield* inner

        return {
          sameState: child.own === outer,
          childTracing: child.tracing,
          parentEnabled: outer.enabled,
          parentState: (yield* useScope()).get(Tracing) === outer,
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
        yield* Trace.actions.enableTracing()

        return {
          active: yield* ActiveSpan.get(),
          suppressed: yield* Suppressed.get(),
        }
      }),
    )

    expect(pinned).toEqual({ active: null, suppressed: false })
  })

  it('no Trace sink installed and no enableTracing ⇒ tracing is off', async () => {
    expect(unwrap(await run(() => Trace.actions.isTracing()))).toBe(false)
    expect(
      unwrap(
        await run(function* () {
          return (yield* useScope()).get(Tracing)
        }),
      ),
    ).toBeUndefined()
  })
})
