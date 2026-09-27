/**
 * Queue telemetry: `enqueue` is a PRODUCER span whose context rides the job row; every attempt is
 * a ROOT CONSUMER span linking the enqueue (`creation`) and the previous attempt (`queue.retry`);
 * a failure with attempts left is WARN, a dead letter ERROR + `ozaco.queue.dead`.
 */
import { column, DbClient, defineSchema, table } from 'db:core'
import { Queue, queueTable } from 'db:queue'
import type { Operation } from 'std:effect'
import { run, sleep } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { parseTraceparent, span, traceparentOf } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import { captureLogs, traced } from './helpers'

const schema = defineSchema({ jobs: queueTable('jobs') })

function* bootstrap(sqlite = false) {
  yield* BunIO.use()
  yield* sqlite ? SqliteAdapter.use() : MemoryAdapter.use()
  yield* DbClient.use({ schema })
  yield* Queue.use({ table: 'jobs' })
}

/** Poll `probe` until it answers true (or fail after `ms`). */
function* until(probe: () => Operation<boolean>, ms = 3000) {
  const deadline = Date.now() + ms

  while (!(yield* probe())) {
    if (Date.now() > deadline) {
      return yield* fail('test.timeout', `condition not met within ${ms}ms`)
    }

    yield* sleep(5)
  }
}

const sameSpan = (link: TraceDef.Link, data: TraceDef.SpanData): boolean =>
  link.context.traceId === data.context.traceId && link.context.spanId === data.context.spanId

describe('queue telemetry', () => {
  it('enqueue: a PRODUCER `send {queue}` span whose context the job row keeps', async () => {
    const { tracer, value: row } = await traced(function* () {
      yield* bootstrap()
      const { job } = yield* span('request', () => Queue.actions.enqueue('email', { to: 'ada' }))
      return job
    })

    const send = tracer.span('send jobs')
    expect(send.kind).toBe('producer')
    expect(send.parent?.spanId).toBe(tracer.span('request').context.spanId)
    expect(send.attributes).toMatchObject({
      'messaging.system': 'ozaco.queue',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'enqueue',
      'messaging.destination.name': 'jobs',
      'messaging.message.id': row._id,
      'ozaco.queue.kind': 'email',
      'ozaco.queue.op': 'inserted',
    })
    // the row write is the producer's child
    expect(tracer.span('insert jobs').parent?.spanId).toBe(send.context.spanId)
    expect(row.traceparent).toBe(traceparentOf(send.context))
    expect(row.last_traceparent).toBeNull()
  })

  it('an attempt: a ROOT `process {queue}` CONSUMER span linking the enqueue', async () => {
    const { tracer, value: jobId } = await traced(function* () {
      yield* bootstrap()
      const worker = yield* Queue.actions.work(
        {
          *email(job) {
            // the handler's db work nests under the attempt
            yield* Queue.actions.get(job.id)
          },
        },
        { pollMs: 5 },
      )
      const { job } = yield* span('request', () => Queue.actions.enqueue('email', null))
      yield* until(function* () {
        return worker.stats().done === 1
      })
      yield* sleep(5)
      return job._id
    })

    const send = tracer.span('send jobs')
    const process = tracer.span('process jobs')
    expect(process.kind).toBe('consumer')
    expect(process.parent).toBeNull()
    expect(process.context.traceId).not.toBe(send.context.traceId)
    expect(process.attributes).toMatchObject({
      'messaging.system': 'ozaco.queue',
      'messaging.operation.type': 'process',
      'messaging.operation.name': 'work',
      'messaging.destination.name': 'jobs',
      'messaging.message.id': jobId,
      'ozaco.queue.kind': 'email',
      'ozaco.queue.attempt': 1,
    })
    expect(process.status).toEqual({ code: 'unset' })
    expect(process.links).toHaveLength(1)
    expect(sameSpan(process.links[0]!, send)).toBe(true)
    expect(process.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'creation' })

    // the handler's read and the settle write are the attempt's children; the claim loop is not
    const children = tracer.spans.filter(data => data.parent?.spanId === process.context.spanId)
    expect(children.map(data => data.name).toSorted()).toEqual(['find jobs', 'update jobs'])
    expect(tracer.exceptions()).toEqual([])
  })

  it('an attempt runs as the queue service: the table name, unless Queue.use / work name one', async () => {
    const attempt = async (options: { use?: string; work?: string } = {}) => {
      const { tracer } = await traced(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* DbClient.use({ schema })
        yield* Queue.use({ table: 'jobs', service: options.use })
        const worker = yield* Queue.actions.work(
          {
            *email(job) {
              yield* Queue.actions.get(job.id)
            },
          },
          { pollMs: 5, service: options.work },
        )
        yield* span('request', () => Queue.actions.enqueue('email', null))
        yield* until(function* () {
          return worker.stats().done === 1
        })
        yield* sleep(5)
      })

      return tracer
    }

    const plain = await attempt()
    const process = plain.span('process jobs')
    // a root span: without a service of its own it would be the node's default (null)
    expect(process.service).toBe('jobs')
    // everything under the attempt runs as it; the producer stays its caller's
    const children = plain.spans.filter(data => data.parent?.spanId === process.context.spanId)
    expect(children.map(data => data.service)).toEqual(['jobs', 'jobs'])
    expect(plain.span('send jobs').service).toBeNull()

    const named = await attempt({ use: 'mailer' })
    expect(named.span('process jobs').service).toBe('mailer')
    const overridden = await attempt({ use: 'mailer', work: 'billing' })
    expect(overridden.span('process jobs').service).toBe('billing')
  })

  it('a retry is WARN and links the previous attempt; the dead letter is ERROR + ozaco.queue.dead', async () => {
    const { tracer, value: row } = await traced(function* () {
      yield* bootstrap(true)
      const worker = yield* Queue.actions.work(
        {
          *flaky(job) {
            return yield* fail('test.flaky', `boom ${job.attempt}`)
          },
        },
        { maxAttempts: 2, backoff: { kind: 'linear', stepMs: 5 }, pollMs: 5 },
      )
      const { job } = yield* Queue.actions.enqueue('flaky', null)
      yield* until(function* () {
        return worker.stats().dead === 1
      })
      yield* sleep(5)
      return (yield* Queue.actions.get(job._id))!
    })

    const send = tracer.span('send jobs')
    // an enqueue outside any span is a root of its own
    expect(send.parent).toBeNull()

    const [first, second] = tracer.all('process jobs')
    expect(first!.attributes['ozaco.queue.attempt']).toBe(1)
    expect(second!.attributes['ozaco.queue.attempt']).toBe(2)

    // attempt 1: handled by the retry — status unset, the failure's type marks it
    expect(first!.status).toEqual({ code: 'unset' })
    expect(first!.attributes['error.type']).toBe('test.flaky')
    expect(first!.links.map(link => link.attributes?.['ozaco.link.reason'])).toEqual(['creation'])

    // attempt 2: dead — an error, the event, and a link back to attempt 1
    expect(second!.status).toEqual({ code: 'error', message: 'boom 2' })
    // events in time order: the failure, then its dead-lettering
    expect(second!.events.map(event => event.name)).toEqual(['exception', 'ozaco.queue.dead'])
    expect(second!.links.map(link => link.attributes?.['ozaco.link.reason'])).toEqual([
      'creation',
      'queue.retry',
    ])
    expect(sameSpan(second!.links[0]!, send)).toBe(true)
    expect(sameSpan(second!.links[1]!, first!)).toBe(true)

    const exceptions = tracer.exceptions()
    expect(exceptions.map(log => [log.eventName, log.severityNumber, log.body])).toEqual([
      ['messaging.process.exception', 13, 'test.flaky: boom 1'],
      ['messaging.process.exception', 17, 'test.flaky: boom 2'],
    ])

    // the row: the chain as last_error, the dead attempt as last_traceparent
    expect(row.state).toBe('dead')
    expect(row.last_error).toBe('test.flaky: boom 2')
    expect(parseTraceparent(row.last_traceparent)?.spanId).toBe(second!.context.spanId)
  })

  it('last_error keeps the whole cause chain of a thrown error', async () => {
    const { value: row } = await traced(function* () {
      yield* bootstrap()
      const worker = yield* Queue.actions.work(
        {
          *explode() {
            throw new TypeError('bad payload')
          },
        },
        { maxAttempts: 1, pollMs: 5 },
      )
      const { job } = yield* Queue.actions.enqueue('explode', null)
      yield* until(function* () {
        return worker.stats().dead === 1
      })
      return (yield* Queue.actions.get(job._id))!
    })

    // a thrown Error is the runtime's `std:result.unknown` fold of it: its text, never its frames
    expect(row.last_error).toBe('std:result.unknown: TypeError: bad payload')
    expect(new TextEncoder().encode(row.last_error!).length).toBeLessThanOrEqual(4096)
  })

  it('tracing off: nothing stored, the queue works as before', async () => {
    const row = unwrap(
      await run(function* () {
        yield* bootstrap()
        const worker = yield* Queue.actions.work({ *ping() {} }, { pollMs: 5 })
        const { job } = yield* Queue.actions.enqueue('ping', null)
        yield* until(function* () {
          return worker.stats().done === 1
        })
        return (yield* Queue.actions.get(job._id))!
      }),
    )

    expect(row.state).toBe('done')
    expect(row.traceparent).toBeNull()
    expect(row.last_traceparent).toBeNull()
  })

  it('a lapsed lease is logged (WARN, logger @ozaco/db)', async () => {
    const { value: logs } = await traced(function* () {
      const entries = yield* captureLogs()
      yield* bootstrap()
      const db = (yield* DbClient.context.expect()) as AnyType

      // what a crashed worker leaves behind: running, lease long gone
      const orphan = yield* db.insert('jobs', {
        kind: 'work',
        state: 'running',
        run_at: Date.now() - 1000,
        attempts: 1,
        lease_until: Date.now() - 500,
        worker: 'ghost',
      })

      const worker = yield* Queue.actions.work(
        {
          *work() {},
        },
        { pollMs: 5, leaseMs: 300, sweepMs: 10, backoff: () => 0 },
      )
      yield* until(function* () {
        return worker.stats().swept === 1
      })
      return entries.filter(entry => entry.data?.['messaging.message.id'] === orphan._id)
    })

    expect(logs.map(entry => [entry.level, entry.msg, entry.bindings.logger])).toEqual([
      [40, 'db queue: a lease expired — its worker is gone', '@ozaco/db'],
    ])
    // the attempt span's own keys (one key per concept)
    expect(logs[0]!.data).toMatchObject({
      'messaging.destination.name': 'jobs',
      'ozaco.queue.kind': 'work',
      'ozaco.queue.worker': 'ghost',
      'ozaco.queue.state': 'failed',
    })
  })

  it('a table declared without the trace columns runs untraced', async () => {
    const legacy = table('legacy', {
      kind: column.text(),
      payload: column.json<unknown>().optional(),
      state: column.enumOf('queued', 'running', 'done', 'failed', 'dead').default('queued'),
      dedupe_key: column.text().optional(),
      priority: column.int().default(0),
      run_at: column.timestamp({ as: 'ms' }),
      attempts: column.int().default(0),
      max_attempts: column.int().optional(),
      lease_until: column.timestamp({ as: 'ms' }).optional(),
      worker: column.text().optional(),
      last_error: column.text().optional(),
      finished_at: column.timestamp({ as: 'ms' }).optional(),
    }).unique('by_dedupe', ['dedupe_key'])

    const { tracer, value: row } = await traced(function* () {
      yield* BunIO.use()
      yield* MemoryAdapter.use()
      yield* DbClient.use({ schema: defineSchema({ legacy }) })
      yield* Queue.use({ table: 'legacy' })
      const worker = yield* Queue.actions.work({ *ping() {} }, { pollMs: 5 })
      const { job } = yield* Queue.actions.enqueue('ping', null)
      yield* until(function* () {
        return worker.stats().done === 1
      })
      yield* sleep(5)
      return (yield* Queue.actions.get(job._id)) as AnyType
    })

    expect(row.state).toBe('done')
    expect(row.traceparent).toBeUndefined()
    // the spans still happen (the producer has nothing to store, the attempt nothing to link)
    expect(tracer.span('process legacy').links).toEqual([])
  })
})
