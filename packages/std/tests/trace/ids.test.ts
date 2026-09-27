import { run } from 'std:effect'
import { unwrap } from 'std:result'
import { newSpanId, newTraceId, span, TraceIds } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { sequentialIds, traced } from './helpers'

describe('ids', () => {
  it('mints lowercase-hex, non-zero W3C ids', async () => {
    const ids = unwrap(
      await run(function* () {
        const out: { trace: string; span: string }[] = []
        for (let at = 0; at < 50; at += 1) {
          out.push({ trace: yield* newTraceId(), span: yield* newSpanId() })
        }
        return out
      }),
    )

    for (const { trace, span: spanId } of ids) {
      expect(trace).toMatch(/^[\da-f]{32}$/u)
      expect(spanId).toMatch(/^[\da-f]{16}$/u)
      expect(trace).not.toBe('0'.repeat(32))
      expect(spanId).not.toBe('0'.repeat(16))
    }

    expect(new Set(ids.map(id => id.trace)).size).toBe(50)
    expect(new Set(ids.map(id => id.span)).size).toBe(50)
  })

  it('honours a pinned TraceIds generator', async () => {
    const ids = unwrap(
      await run(() =>
        TraceIds.with(sequentialIds(), function* () {
          return [yield* newTraceId(), yield* newSpanId(), yield* newSpanId()]
        }),
      ),
    )

    expect(ids).toEqual([`${'0'.repeat(31)}1`, `${'0'.repeat(15)}1`, `${'0'.repeat(15)}2`])
  })

  it('spans take their ids from TraceIds', async () => {
    const { tracer } = await traced(() =>
      TraceIds.with(sequentialIds(), () => span('root', () => span('child', function* () {}))),
    )

    const root = tracer.span('root')
    const child = tracer.span('child')

    expect(root.context.traceId).toBe(`${'0'.repeat(31)}1`)
    expect(root.context.spanId).toBe(`${'0'.repeat(15)}1`)
    expect(child.context.traceId).toBe(root.context.traceId)
    expect(child.context.spanId).toBe(`${'0'.repeat(15)}2`)
    expect(child.parent?.spanId).toBe(root.context.spanId)
  })

  it('mints ids without tracing (the server correlates calls with them)', async () => {
    const id = unwrap(await run(() => newSpanId()))
    expect(id).toMatch(/^[\da-f]{16}$/u)
  })
})
