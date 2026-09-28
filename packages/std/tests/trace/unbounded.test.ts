import { DefaultLogger, Logger } from 'std:logger'
/**
 * The chain rendering has no limit (every level, every cause), so a record must still stay what a
 * backend accepts: a chain of any depth or size renders without overflowing the stack, and the
 * span / log record it becomes keeps the generic value limits — no failure anywhere.
 */
import type { Result } from 'std:result'
import { fail, formatFailure } from 'std:result'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { TraceTransport } from 'std:logger/transport/trace'

import { tracedResult } from './helpers'

const LEVELS = 50_000

/** A chain `LEVELS` deep, each level with a string cause, around a 100 KB root message. */
const deepChain = (): Result.Failure<unknown> => {
  let failure: Result.Failure<unknown> = fail('root.cause', 'x'.repeat(100_000))

  for (let index = 0; index < LEVELS; index += 1) {
    failure = fail(`level.${index}`, `wrapping ${index}`, `cause ${index}`, failure)
  }

  return failure
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

describe('an unbounded chain never fails telemetry', () => {
  it('renders every level without overflowing the stack', () => {
    const rendered = formatFailure(deepChain(), { chain: true })

    expect(rendered.startsWith(`level.${LEVELS - 1}: wrapping ${LEVELS - 1}`)).toBe(true)
    expect(rendered.endsWith(`Caused by: root.cause: ${'x'.repeat(100_000)}`)).toBe(true)
  })

  it('a Logger line carrying it becomes one bounded record through TraceTransport', async () => {
    const { tracer, result } = await tracedResult(function* () {
      yield* DefaultLogger.use()
      yield* TraceTransport.use()

      yield* Trace.actions.span('dispatch', () => Logger.actions.error('it broke', deepChain()))
    })

    expect(result).toMatchObject({ value: undefined })
    expect(tracer.exceptions()).toHaveLength(1)
    expect(bytes(tracer.logs)).toBeLessThan(512 * 1024)
  })

  it('records into a span and a log record that stay under the generic limits', async () => {
    const { tracer, result } = await tracedResult(() =>
      Trace.actions.span('dispatch', () => deepChain()),
    )

    expect(result).toMatchObject({ error: `level.${LEVELS - 1}` })

    const span = tracer.span('dispatch')
    const [event] = span.events
    const [log] = tracer.exceptions()

    expect(event?.name).toBe('exception')
    expect(event!.attributes!['ozaco.failure.chain']).toHaveLength(128)
    expect(log!.attributes['ozaco.failure.chain']).toHaveLength(128)
    expect(bytes(span)).toBeLessThan(512 * 1024)
    expect(bytes(log)).toBeLessThan(512 * 1024)
  })
})
