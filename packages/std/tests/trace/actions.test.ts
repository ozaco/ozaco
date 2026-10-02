import { run } from 'std:effect'
import { unwrap } from 'std:result'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { sequentialIds, traced } from './helpers'

const INBOUND = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: 1 }

describe('scope actions', () => {
  it('detached runs the body with no active span', async () => {
    const { value } = await traced(() =>
      Trace.actions.span('outer', function* () {
        return yield* Trace.actions.detached(() => Trace.actions.activeContext())
      }),
    )

    expect(value).toBeNull()
  })

  it('activate makes a context active in the scope and restore gives the previous state back', async () => {
    const seen = unwrap(
      await run(function* () {
        const restore = yield* Trace.actions.activate(INBOUND)
        const during = yield* Trace.actions.activeContext()

        restore()

        return { during, after: yield* Trace.actions.activeContext() }
      }),
    )

    expect(seen.during?.spanId).toBe(INBOUND.spanId)
    expect(seen.after).toBeNull()
  })

  it('activate of a live span makes its span active', async () => {
    const { value } = await traced(function* () {
      const live = yield* Trace.actions.startSpan('held')
      const restore = yield* Trace.actions.activate(live)
      const during = yield* Trace.actions.activeContext()

      restore()
      yield* live.end()

      return { during, spanId: live.context.spanId }
    })

    expect(value.during?.spanId).toBe(value.spanId)
  })

  it('active() is re-entered by passThrough as it was — a recording span stays one', async () => {
    const { value } = await traced(() =>
      Trace.actions.span('dispatch', function* (handle) {
        const active = yield* Trace.actions.active()

        // produced later, outside the span's body: the same span, still recording
        const carrier = yield* Trace.actions.detached(() =>
          Trace.actions.passThrough(active!, () => Trace.actions.inject({ ozaco: true })),
        )

        return { carrier, spanId: handle.context.spanId }
      }),
    )

    expect(value.carrier.traceparent).toContain(`-${value.spanId}-`)
    expect(value.carrier.tracestate).toBe('ozaco=1')
  })

  it('a context re-entered from activeContext keeps its tracestate', async () => {
    const inbound = { ...INBOUND, state: 'vendor=abc' }
    const carrier = unwrap(
      await run(() =>
        Trace.actions.passThrough(inbound, function* () {
          const active = yield* Trace.actions.activeContext()

          return yield* Trace.actions.detached(() =>
            Trace.actions.passThrough(active!, () => Trace.actions.inject()),
          )
        }),
      ),
    )

    expect(carrier).toEqual({
      traceparent: `00-${INBOUND.traceId}-${INBOUND.spanId}-01`,
      tracestate: 'vendor=abc',
    })
  })

  it('an invalid context is never written, carried or activated', async () => {
    const bad = { traceId: 'zz', spanId: 'yy', flags: 1 }
    const seen = unwrap(
      await run(function* () {
        const injected = yield* Trace.actions.inject({ context: bad })
        const carried = yield* Trace.actions.passThrough(bad, () => Trace.actions.activeContext())
        const restore = yield* Trace.actions.activate(bad)
        const activated = yield* Trace.actions.activeContext()

        restore()

        return { injected, carried, activated }
      }),
    )

    expect(seen).toEqual({ injected: {}, carried: null, activated: null })
  })

  it('isSuppressed reports a suppressed body', async () => {
    const seen = unwrap(
      await run(function* () {
        const inside = yield* Trace.actions.suppressed(() => Trace.actions.isSuppressed())

        return { inside, outside: yield* Trace.actions.isSuppressed() }
      }),
    )

    expect(seen).toEqual({ inside: true, outside: false })
  })

  it('useIds pins the ids of the current scope', async () => {
    const ids = unwrap(
      await run(function* () {
        yield* Trace.actions.useIds(sequentialIds())

        return [yield* Trace.actions.newTraceId(), yield* Trace.actions.newSpanId()]
      }),
    )

    expect(ids).toEqual([`${'0'.repeat(31)}1`, `${'0'.repeat(15)}1`])
  })
})
