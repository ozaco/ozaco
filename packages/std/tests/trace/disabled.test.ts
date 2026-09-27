import { run, spawn } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  ActiveSpan,
  activeContext,
  current,
  enableTracing,
  event,
  extract,
  inject,
  parseTraceparent,
  passThrough,
  recordFailure,
  span,
  startSpan,
  suppressed,
  TraceIds,
} from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { memoryTracer, traced, tracedResult } from './helpers'

const INBOUND = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** Ids that fail the test when anything asks for one. */
const forbiddenIds: TraceDef.Ids = {
  trace: () => {
    throw new Error('a trace id was minted')
  },
  span: () => {
    throw new Error('a span id was minted')
  },
}

describe('tracing off', () => {
  it('span() runs the body with a no-op handle, mints nothing, records nothing', async () => {
    const tracer = memoryTracer()

    const seen = unwrap(
      await run(function* () {
        // an installed tracer in a scope where tracing is OFF receives nothing
        yield* tracer.plugin.use()
        yield* enableTracing(false)

        return yield* TraceIds.with(forbiddenIds, () =>
          span('off', function* (handle) {
            handle.setAttributes({ ignored: true })
            yield* event('ignored')
            yield* recordFailure(fail('app.ignored'))
            const live = yield* startSpan('live')
            yield* live.run(function* () {})
            yield* live.end()
            return { recording: handle.recording, active: yield* ActiveSpan.get() }
          }),
        )
      }),
    )

    expect(seen).toEqual({ recording: false, active: null })
    expect(tracer.spans).toEqual([])
    expect(tracer.logs).toEqual([])
  })

  it('a pass-through inbound context stays active and is what inject() forwards', async () => {
    const inbound = extract(name => (name === 'traceparent' ? INBOUND : 'vendor=abc'))!

    const seen = unwrap(
      await run(() =>
        ActiveSpan.with(passThrough(inbound), () =>
          span('off', function* (handle) {
            return {
              context: handle.context,
              recording: handle.recording,
              current: (yield* current()).context,
              carrier: yield* inject(),
            }
          }),
        ),
      ),
    )

    expect(seen.recording).toBe(false)
    expect(seen.context).toMatchObject({ traceId: inbound.traceId, spanId: inbound.spanId })
    expect(seen.current).toEqual(seen.context)
    expect(seen.carrier).toEqual({ traceparent: INBOUND, tracestate: 'vendor=abc' })
  })

  it('a span opened under a pass-through context (tracing on) continues its trace', async () => {
    const inbound = parseTraceparent(INBOUND)!

    const { tracer } = await traced(() =>
      ActiveSpan.with(passThrough(inbound), () => span('continued', function* () {})),
    )

    const data = tracer.span('continued')
    expect(data.context.traceId).toBe(inbound.traceId)
    expect(data.parent).toEqual({ ...inbound, remote: true })
  })
})

describe('a tracing-OFF scope under a traced one', () => {
  it('sees the outer span (its context propagates) but can never write to it', async () => {
    const { tracer, value } = await traced(() =>
      span('outer', function* (outer) {
        const task = yield* spawn(function* () {
          yield* enableTracing(false)

          return yield* span('off', function* (handle) {
            handle.setAttributes({ leaked: true })
            handle.setStatus({ code: 'error', message: 'leaked' })
            handle.addEvent('leaked')
            const seen = yield* current()
            seen.updateName('renamed')
            return {
              recording: handle.recording,
              same: seen.context.spanId === outer.context.spanId,
              carrier: yield* inject(),
            }
          })
        })

        return { ...(yield* task), outer: outer.context.spanId }
      }),
    )

    expect(value.recording).toBe(false)
    expect(value.same).toBe(true)
    expect(value.carrier.traceparent).toContain(value.outer)

    const outer = tracer.span('outer')
    expect(outer.attributes).toEqual({})
    expect(outer.events).toEqual([])
    expect(outer.status.code).toBe('unset')
  })
})

describe('requireParent', () => {
  it('no parent ⇒ no span (the body still runs)', async () => {
    const { tracer, value } = await traced(() =>
      span('db', { requireParent: true, kind: 'client' }, function* (handle) {
        return handle.recording
      }),
    )

    expect(value).toBe(false)
    expect(tracer.spans).toEqual([])
  })

  it('a recording parent ⇒ a child span', async () => {
    const { tracer } = await traced(() =>
      span('handler', () => span('db', { requireParent: true }, function* () {})),
    )

    expect(tracer.span('db').parent?.spanId).toBe(tracer.span('handler').context.spanId)
  })

  it('an unsampled parent ⇒ no span, the parent stays active', async () => {
    const { tracer, value } = await traced(() =>
      span('poll', { sampled: false }, function* (poll) {
        return yield* span('db', { requireParent: true }, function* () {
          return (yield* current()).context.spanId === poll.context.spanId
        })
      }),
    )

    expect(value).toBe(true)
    expect(tracer.spans).toEqual([])
  })

  it('a sampled remote parent counts as recording', async () => {
    const { tracer } = await traced(() =>
      span('db', { requireParent: true, parent: parseTraceparent(INBOUND)! }, function* () {}),
    )

    expect(tracer.span('db').context.traceId).toBe(parseTraceparent(INBOUND)!.traceId)
  })
})

describe('suppressed', () => {
  it('acts as tracing off: no spans, no events, no records — and an unsampled context goes out', async () => {
    const { tracer, value } = await traced(() =>
      span('outer', function* () {
        return yield* suppressed(function* () {
          const inner = yield* span('inner', function* (handle) {
            handle.setAttributes({ leaked: true })
            return handle.recording
          })
          yield* event('ignored')
          yield* recordFailure(fail('app.ignored'))
          ;(yield* current()).setAttributes({ leaked: true })
          return { inner, carrier: yield* inject() }
        })
      }),
    )

    expect(value.inner).toBe(false)
    // sampled bit clear; the random bit of a trace id minted here stays (W3C MUST)
    expect(value.carrier.traceparent?.endsWith('-02')).toBe(true)
    expect(tracer.names()).toBe('outer')
    expect(tracer.span('outer').attributes).toEqual({})
    expect(tracer.logs).toEqual([])
  })
})

describe('sampling', () => {
  it('sampled: false on a root ⇒ ids and a context, no SpanData, flags without the sampled bit', async () => {
    const { tracer, value } = await traced(() =>
      span('unsampled', { sampled: false }, function* (root) {
        const child = yield* span('child', function* (handle) {
          return handle.context
        })
        return { root: root.context, recording: root.recording, child, carrier: yield* inject() }
      }),
    )

    expect(value.recording).toBe(false)
    expect(value.root.flags).toBe(2)
    expect(value.child.flags).toBe(2)
    expect(value.child.traceId).toBe(value.root.traceId)
    expect(value.carrier.traceparent?.endsWith('-02')).toBe(true)
    expect(tracer.spans).toEqual([])
  })

  it('an unsampled remote parent ⇒ non-recording, but exception and event records still go out', async () => {
    const parent = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')!

    const { tracer, result } = await tracedResult(() =>
      span('handler', { parent }, function* () {
        yield* event('ozaco.step', { 'ozaco.step.name': 'load' })
        return yield* fail('app.broken', 'nope')
      }),
    )

    expect(result).toMatchObject({ error: 'app.broken' })
    expect(tracer.spans).toEqual([])

    const [step, exception] = tracer.logs
    expect(step).toMatchObject({ eventName: 'ozaco.step', severityNumber: 9 })
    expect(step!.context?.traceId).toBe(parent.traceId)
    expect(step!.context!.flags & 1).toBe(0)
    expect(exception).toMatchObject({ eventName: 'exception', severityNumber: 17 })
    expect(exception!.context!.flags & 1).toBe(0)
    expect(exception!.attributes['exception.type']).toBe('app.broken')
  })

  it('sampled: false opts a child out under a sampled parent', async () => {
    const { tracer } = await traced(() =>
      span('parent', () =>
        span('opted-out', { sampled: false }, () => span('grandchild', function* () {})),
      ),
    )

    expect(tracer.names()).toBe('parent')
  })
})

describe('activeContext', () => {
  it('the active span, a pass-through, or null — also under suppression', async () => {
    const inbound = parseTraceparent(INBOUND)!

    const off = unwrap(
      await run(function* () {
        const none = yield* activeContext()
        const through = yield* ActiveSpan.with(passThrough(inbound), () => activeContext())
        return { none, through }
      }),
    )

    expect(off.none).toBeNull()
    expect(off.through).toEqual({ ...inbound, remote: true })

    const { value } = await traced(() =>
      span('on', function* (handle) {
        return { handle: handle.context, quiet: yield* suppressed(() => activeContext()) }
      }),
    )

    expect(value.quiet).toEqual({
      traceId: value.handle.traceId,
      spanId: value.handle.spanId,
      flags: value.handle.flags,
    })
  })
})
