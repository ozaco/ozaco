/**
 * Settled exceptions reach the std Logger — the console / terminal (live finding #4): every
 * exception record at WARN or above the kernel's tracer hands to the sinks is ALSO written to the
 * installed Logger, once — the failure attached when it escaped a kernel span (else the record's
 * rendered chain as the line), bound `ozaco.telemetry = 'sent'` so its `TraceTransport` does not
 * emit it a second time. A failure a LOG LINE recorded (`ctx.log`, a Logger line) is not
 * forwarded: the Logger printed that line itself.
 */
import type { ObserveDef } from 'server:core'
import { action, createServer, ObserveExporter, Server, service, ServerErrors } from 'server:core'
import { markLogged } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LoggerTransport, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { fail, ResultErrors, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage } from '../helpers'

let installs = 0

/** Every observed event of the node it is installed on. */
const memoryExporter = () => {
  installs += 1

  const events: ObserveDef.Event[] = []

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/logger-forward-exporter-${installs}`,
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push(event)
    },
    *start() {},
    *flush() {},
  })

  const logs = (): TraceDef.LogData[] =>
    events.flatMap(event => (event.t === 'log' ? [event.log] : []))
  const spans = (): TraceDef.SpanData[] =>
    events.flatMap(event => (event.t === 'span' ? [event.span] : []))
  const exceptions = (): TraceDef.LogData[] =>
    logs().filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, logs, spans, exceptions }
}

/** A Logger transport keeping every entry the Logger writes. */
const captureTransport = () => {
  installs += 1

  const entries: LoggerDef.Entry[] = []

  const plugin = LoggerTransport.implement({
    name: `test/logger-forward-capture-${installs}`,
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace }
    },
  }).build({
    *write(entry: LoggerDef.Entry) {
      entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  return { plugin, entries }
}

const DEAD = fail('jobs.dead', 'the job died')

const jobs = service('jobs', {
  crash: action.query({}, function* () {
    return yield* fail('jobs.crash', 'the job crashed')
  }),
  thrown: action.query({}, function* () {
    throw new TypeError('the job threw')
  }),
  strict: action.query({ input: z.object({ n: z.number() }) }, function* ({ input }) {
    return input.n
  }),
  careful: action.query({}, function* ({ ctx }) {
    yield* ctx.log.warn('careful', { err: fail('jobs.careful', 'watch out') })

    return 'ok'
  }),
  logged: action.query({}, function* () {
    yield* Logger.actions.warn('logged', fail('jobs.logged', 'the Logger saw it'))

    return 'ok'
  }),
  dead: action.query({}, function* () {
    // recorded where it happened (a queue's dead letter): it never escapes a kernel span
    yield* Trace.actions.recordFailure(DEAD)

    return 'ok'
  }),
  quiet: action.query({}, function* () {
    yield* Trace.actions.recordFailure(fail('jobs.quiet', 'below warn'), { severity: 5 })

    return 'ok'
  }),
  inner: action.query({}, function* () {
    return yield* fail('jobs.inner', 'the inner step failed')
  }),
  late: action.query({}, function* ({ ctx }): Operation<unknown> {
    // the failure is born in `jobs.inner` — and settles only when this dispatch ends, later
    const failed = yield* attempt(ctx.call(jobs, 'inner'))

    yield* sleep(40)

    return yield* failed as Result.Failure<unknown>
  }),
  swallowed: action.query({}, function* () {
    // a plugin's pattern: record what it swallowed, then say so in its own words
    const failure = fail('jobs.swallowed', 'the plugin swallowed it')

    markLogged(failure)
    yield* Trace.actions.recordFailure(failure, { severity: 13 })
    yield* Logger.actions.warn('swallowed it', { error: failure })

    return 'ok'
  }),
})

/** A node with a Logger (+ the capture transport) and an exporter; `body` calls it. */
const withLogger = async (body: (server: AnyType) => Operation<void>) => {
  const sink = memoryExporter()
  const capture = captureTransport()

  unwrap(
    await run(function* () {
      yield* storage()
      yield* DefaultLogger.use({ level: LogLevel.trace })
      yield* capture.plugin.use()

      const server = yield* createServer({ services: [jobs], plugins: [sink.plugin] })

      yield* body(server)
    }),
  )

  return { sink, entries: capture.entries }
}

/** The entries the tracer forwarded (bound `ozaco.telemetry = 'sent'`, no `ctx.log` line). */
const forwarded = (entries: readonly LoggerDef.Entry[]) =>
  entries.filter(entry => entry.bindings['ozaco.telemetry'] === 'sent' && entry.msg !== 'careful')

describe('settled exceptions reach the std Logger', () => {
  it('a failed dispatch: ONE Logger line at ERROR, the failure attached, no second record', async () => {
    let failed: Result.Failure<unknown> | undefined

    const { sink, entries } = await withLogger(function* (server) {
      failed = (yield* attempt(server.call(jobs, 'crash'))) as Result.Failure<unknown>
    })

    const lines = forwarded(entries)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: LogLevel.error,
      msg: 'ozaco.action.exception',
      bindings: { 'ozaco.telemetry': 'sent', logger: '@ozaco/server' },
    })
    // the very failure the caller got — its chain prints with it
    expect(lines[0]!.failures[0]).toBe(failed!)

    // the sinks hold the one exception record, nothing the Logger line added
    expect(sink.exceptions()).toHaveLength(1)
    expect(sink.logs().filter(log => log.body === 'ozaco.action.exception')).toEqual([])
  })

  it('a thrown error (`asFailure`’s fold): ONE Logger line at ERROR, that very fold attached', async () => {
    let failed: Result.Failure<unknown> | undefined

    const { sink, entries } = await withLogger(function* (server) {
      failed = (yield* attempt(server.call(jobs, 'thrown'))) as Result.Failure<unknown>
    })

    // the caller gets the fold: `std:result.unknown`, the thrown TypeError its `raw`
    expect(failed!.error).toBe(ResultErrors.Unknown)
    expect(failed!.message).toBe('TypeError: the job threw')
    expect(failed!.raw).toBeInstanceOf(TypeError)

    // the record is typed / worded by the fold (its tag, its message) and recognized as the
    // fold's: the line carries the failure, not the rendered chain
    const lines = forwarded(entries)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: LogLevel.error, msg: 'ozaco.action.exception' })
    expect(lines[0]!.failures[0]).toBe(failed!)
    expect(
      sink
        .exceptions()
        .map(log => [log.attributes['exception.type'], log.attributes['exception.message']]),
    ).toEqual([[ResultErrors.Unknown, 'TypeError: the job threw']])
  })

  it("a forwarded line is the failure's: its origin span's trace / span ids, its own time", async () => {
    const { sink, entries } = await withLogger(function* (server) {
      yield* attempt(server.call(jobs, 'late'))
    })

    const [record] = sink.exceptions()
    const origin = sink.spans().find(span => span.name === 'jobs.inner')!

    expect(sink.exceptions()).toHaveLength(1)
    expect(record!.context?.spanId).toBe(origin.context.spanId)

    const lines = forwarded(entries)

    expect(lines).toHaveLength(1)
    // the terminal shows `trace=…` of the span the failure was born in — not the span (or no
    // span) active where it settled
    expect(lines[0]!.trace).toMatchObject({
      traceId: origin.context.traceId,
      spanId: origin.context.spanId,
    })
    // stamped when it happened (the record's time), not when it settled 40 ms later: the line
    // sorts where the failure belongs among the others
    expect(lines[0]!.time).toBe(Math.trunc(record!.time))
    expect(lines[0]!.time).toBeLessThan(origin.end + 1)
  })

  it('a handled / client failure is forwarded at WARN', async () => {
    const { entries } = await withLogger(function* (server) {
      yield* attempt(server.call(jobs, 'strict', { n: 'x' } as AnyType))
    })

    const lines = forwarded(entries)

    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe(LogLevel.warn)
    expect(lines[0]!.failures[0]!.error).toBe(ServerErrors.Validation)
  })

  it('a failure a log line recorded is not printed twice (ctx.log, a Logger line)', async () => {
    const { sink, entries } = await withLogger(function* (server) {
      yield* server.call(jobs, 'careful')
      yield* server.call(jobs, 'logged')
    })

    // each line once — the exception record it made is not forwarded back
    expect(entries.filter(entry => entry.msg === 'careful')).toHaveLength(1)
    expect(entries.filter(entry => entry.msg === 'logged')).toHaveLength(1)
    expect(forwarded(entries).filter(entry => entry.msg !== 'logged')).toEqual([])
    expect(sink.exceptions().map(log => log.attributes['exception.type'])).toEqual([
      'jobs.careful',
      'jobs.logged',
    ])
  })

  it('a failure its caller logs itself (markLogged) — or a buffered trace’s — is not printed twice', async () => {
    const { sink, entries } = await withLogger(function* (server) {
      yield* server.call(jobs, 'swallowed')

      // an errors-only root: its records are held until it ends — after the Logger line
      yield* Server.actions.span(
        'background',
        function* () {
          const failure = fail('jobs.later', 'recorded before it was logged')

          yield* Trace.actions.recordFailure(failure, { severity: 13 })
          yield* Logger.actions.warn('logged later', { error: failure })
        },
        { parent: null, record: 'errors' },
      )
    })

    expect(entries.filter(entry => entry.msg === 'swallowed it')).toHaveLength(1)
    expect(entries.filter(entry => entry.msg === 'logged later')).toHaveLength(1)
    expect(forwarded(entries)).toEqual([])
    expect(sink.exceptions().map(log => log.attributes['exception.type'])).toEqual([
      'jobs.swallowed',
      'jobs.later',
    ])
  })

  it('a record whose failure never escaped a kernel span: its rendered chain is the line', async () => {
    const { entries } = await withLogger(function* (server) {
      yield* server.call(jobs, 'dead')
      yield* server.call(jobs, 'quiet')
    })

    const lines = forwarded(entries)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: LogLevel.error, failures: [] })
    expect(lines[0]!.msg).toStartWith('jobs.dead: the job died')
  })

  it('no Logger installed: nothing is forwarded, the sinks are unchanged', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({ services: [jobs], plugins: [sink.plugin] })

        yield* attempt(server.call(jobs, 'crash'))
      }),
    )

    expect(sink.exceptions()).toHaveLength(1)
  })
})
