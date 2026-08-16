import { Tracer } from 'server:core'
import type { SpanContext } from 'server:core'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { DefaultTracer } from 'server:plugin/trace'
import { BunIO } from 'std:io/impl/bun'

import { runScoped } from '../helpers'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'

/** Bootstrap a scope with `DefaultTracer` installed and run `body` against the Tracer actions. */
const withTracer = <T>(body: () => Operation<T>): Promise<T> =>
  runScoped(function* () {
    yield* install(BunIO)
    yield* install(DefaultTracer)

    return yield* body()
  })

describe('traceparent', () => {
  it('formats version 00 with sampled flags', async () => {
    const header = await withTracer(() =>
      Tracer.actions.formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID }),
    )

    expect(header).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
  })

  it('parses a valid header into a span context', async () => {
    const context = await withTracer(() =>
      Tracer.actions.parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`),
    )

    expect(context).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID })
    expect(context?.parentSpanId).toBeUndefined()
  })

  it('round-trips format → parse', async () => {
    const original = { traceId: TRACE_ID, spanId: SPAN_ID }
    const parsed = await withTracer(function* () {
      const header = yield* Tracer.actions.formatTraceparent(original)

      return yield* Tracer.actions.parseTraceparent(header)
    })

    expect(parsed).toEqual(original)
  })

  it('accepts any two-hex flags value', async () => {
    const context = await withTracer(() =>
      Tracer.actions.parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`),
    )

    expect(context).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID })
  })

  it('rejects malformed headers', async () => {
    const malformed = [
      '',
      'garbage',
      `01-${TRACE_ID}-${SPAN_ID}-01`, // unsupported version
      `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`, // uppercase hex is invalid per spec
      `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`, // short traceId
      `00-${TRACE_ID}-${SPAN_ID.slice(1)}-01`, // short spanId
      `00-${TRACE_ID}-${SPAN_ID}-1`, // short flags
      `00-${TRACE_ID}-${SPAN_ID}`, // missing flags
      `00-${'0'.repeat(32)}-${SPAN_ID}-01`, // all-zero traceId
      `00-${TRACE_ID}-${'0'.repeat(16)}-01`, // all-zero spanId
      ` 00-${TRACE_ID}-${SPAN_ID}-01`, // stray whitespace
    ]

    const parsed = await withTracer(function* () {
      const results: (SpanContext | undefined)[] = []

      for (const header of malformed) {
        results.push(yield* Tracer.actions.parseTraceparent(header))
      }

      return results
    })

    expect(parsed).toHaveLength(malformed.length)

    for (const context of parsed) {
      expect(context).toBeUndefined()
    }
  })
})
