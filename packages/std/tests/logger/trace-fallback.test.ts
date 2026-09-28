/**
 * `TraceTransport` where tracing is OFF (a scope outside every observing node — infrastructure
 * installed before a server): the line still becomes ONE record, through the process fallback
 * sink (`registerFallback`), and nowhere when none is registered.
 */
import type { Operation } from 'std:effect'
import { run, spawn } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { fail, unwrap } from 'std:result'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { TraceTransport } from 'std:logger/transport/trace'

import pkg from '../../package.json'
import { parseTraceparent } from '../../src/trace/internal/propagation'
import { isRecordedIn } from '../../src/trace/internal/registry'
import type { MemoryFallback } from '../trace/helpers'
import { memoryFallback, memoryTracer, withFallbacks } from '../trace/helpers'

const INBOUND = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** A Logger + TraceTransport with NO Trace sink anywhere (tracing never enabled); runs `body`. */
const untraced = <T>(fallback: MemoryFallback | null, body: () => Operation<T>): Promise<T> =>
  withFallbacks(fallback ? [fallback] : [], async () =>
    unwrap(
      await run(function* () {
        yield* DefaultLogger.use({ level: LogLevel.trace, timestamp: () => 4242 })
        yield* TraceTransport.use()

        return yield* body()
      }),
    ),
  )

describe('TraceTransport — through the process fallback', () => {
  it('a line logged where tracing is off becomes ONE record: mapped exactly like a traced one', async () => {
    const fallback = memoryFallback()

    await untraced(fallback, () =>
      Logger.actions.child({ logger: '@ozaco/transport' }, () =>
        Logger.actions.warn('transport connection lost', { 'messaging.system': 'memory' }),
      ),
    )

    expect(fallback.logs).toEqual([
      {
        time: 4242,
        observedTime: expect.any(Number),
        severityNumber: 13,
        severityText: 'WARN',
        body: 'transport connection lost',
        attributes: { 'messaging.system': 'memory' },
        droppedAttributes: 0,
        context: null,
        service: null,
        scope: { name: '@ozaco/transport' },
      },
    ])
  })

  it('without a logger binding the scope is the logger default', async () => {
    const fallback = memoryFallback()

    await untraced(fallback, () => Logger.actions.info('plain'))

    expect(fallback.logs[0]?.scope).toEqual({ name: '@ozaco/std/logger', version: pkg.version })
  })

  it('a failure rides on the line as exception attributes (no span to record it on) — once', async () => {
    const fallback = memoryFallback()
    const failure = fail('db.lease', 'a lease expired')

    await untraced(fallback, function* () {
      yield* Logger.actions.error('queue worker gone', failure)
      // the same failure recorded later outside any trace: no second exception record
      yield* Trace.actions.recordFailure(failure)
    })

    expect(fallback.logs).toHaveLength(1)
    expect(fallback.logs[0]).toMatchObject({
      body: 'queue worker gone',
      severityNumber: 17,
      attributes: {
        'exception.type': 'db.lease',
        'exception.message': 'a lease expired',
      },
    })
    expect(fallback.logs[0]?.eventName).toBeUndefined()
    expect(isRecordedIn(failure, '')).toBe(true)
  })

  it('a pass-through context stamped on the entry is the record’s context', async () => {
    const fallback = memoryFallback()
    const inbound = parseTraceparent(INBOUND)!

    await untraced(fallback, () =>
      Trace.actions.passThrough(inbound, () => Logger.actions.info('carried')),
    )

    expect(fallback.logs[0]?.context).toEqual({
      traceId: inbound.traceId,
      spanId: inbound.spanId,
      flags: 1,
    })
  })

  it('nothing registered: nothing is emitted; suppressed: nothing either', async () => {
    const fallback = memoryFallback()

    await untraced(null, () => Logger.actions.error('nobody listens', fail('app.x')))

    await untraced(fallback, function* () {
      yield* Trace.actions.suppressed(() => Logger.actions.error('from inside an exporter'))
      yield* Logger.actions.child({ 'ozaco.telemetry': 'sent' }, () =>
        Logger.actions.info('ctx.log already emitted it'),
      )
    })

    expect(fallback.logs).toEqual([])
  })

  it('tracing ON in the calling scope: the Trace sink gets the line, never the fallback too', async () => {
    const fallback = memoryFallback()
    const tracer = memoryTracer()

    await untraced(fallback, function* () {
      // root: tracing off ⇒ the fallback
      yield* Logger.actions.info('root line')

      // a traced child scope (a node) under the same root transports ⇒ its Trace sinks
      const node = yield* spawn(function* () {
        yield* tracer.plugin.use()
        yield* Logger.actions.info('node line')
        yield* Trace.actions.span('handler', () => Logger.actions.info('handler line'))
      })

      yield* node
    })

    expect(fallback.logs.map(log => log.body)).toEqual(['root line'])
    expect(tracer.logs.map(log => log.body)).toEqual(['node line', 'handler line'])
  })

  it('a re-install in a child scope replaces the inherited transport: one record per line', async () => {
    const fallback = memoryFallback()
    const tracer = memoryTracer()

    await untraced(fallback, function* () {
      const node = yield* spawn(function* () {
        yield* tracer.plugin.use()
        // the same TraceTransport again (what a node installing its own would do)
        yield* TraceTransport.use()
        yield* Logger.actions.info('once')
      })

      yield* node
      yield* Logger.actions.info('root once')
    })

    expect(tracer.logs.map(log => log.body)).toEqual(['once'])
    expect(fallback.logs.map(log => log.body)).toEqual(['root once'])
  })
})
