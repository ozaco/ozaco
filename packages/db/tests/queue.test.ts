import { column, Db, DbClient, defineSchema, table } from 'db:core'
import type { QueueDef } from 'db:queue'
import { Queue, QueueErrors, queueTable } from 'db:queue'
import type { Operation } from 'std:effect'
import { all, attempt, run, sleep } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { PgAdapter } from 'db:impl/pg'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

const jobs = queueTable('jobs')
const schema = defineSchema({ jobs })

const url = process.env.DB_TEST_PG_URL

const targets: readonly { label: string; enabled: boolean; use: () => Operation<unknown> }[] = [
  { label: 'memory', enabled: true, use: () => MemoryAdapter.use() },
  { label: 'sqlite', enabled: true, use: () => SqliteAdapter.use() },
  { label: 'pg', enabled: Boolean(url), use: () => PgAdapter.use({ url: url! }) },
]

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

function* stateOf(id: string) {
  return (yield* Queue.actions.get(id))?.state
}

for (const target of targets) {
  describe.skipIf(!target.enabled)(`queue — ${target.label}`, () => {
    const bootstrap = function* () {
      yield* target.use()
      yield* BunIO.use()
      yield* DbClient.use({ schema, migrations: 'manual' })
      yield* Db.actions.dropTable('jobs')
      yield* Db.actions.migrate()
      yield* Queue.use({ table: 'jobs' })
    }

    it('runs an enqueued job to done — woken by the change feed, not the poll', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const seen: QueueDef.Job[] = []

          const worker = yield* Queue.actions.work(
            {
              *email(job) {
                seen.push(job)
              },
            },
            { pollMs: 60_000 },
          )

          // the worker is parked on a one-minute poll: only the change feed can wake it
          yield* sleep(20)
          const { op, job } = yield* Queue.actions.enqueue('email', { to: 'ada' })
          expect(op).toBe('inserted')
          expect(job.state).toBe('queued')

          yield* until(function* () {
            return (yield* stateOf(job._id)) === 'done'
          })
          const done = (yield* Queue.actions.get(job._id))!
          expect(done.attempts).toBe(1)
          expect(typeof done.finished_at).toBe('number')
          expect(done.lease_until).toBeNull()
          expect(seen.map(entry => [entry.kind, entry.payload, entry.attempt])).toEqual([
            ['email', { to: 'ada' }, 1],
          ])
          expect(worker.stats()).toMatchObject({ claimed: 1, done: 1, errors: 0 })
          expect(yield* Queue.actions.counts()).toEqual({
            queued: 0,
            running: 0,
            done: 1,
            failed: 0,
            dead: 0,
          })
        }),
      )
    })

    it('retries with backoff, dead-letters after maxAttempts, and retry() revives', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const attempts: number[] = []
          let healthy = false

          const worker = yield* Queue.actions.work(
            {
              *flaky(job) {
                attempts.push(job.attempt)

                if (!healthy) {
                  return yield* fail('test.flaky', `boom ${job.attempt}`)
                }
              },
            },
            { maxAttempts: 3, backoff: { kind: 'linear', stepMs: 10 }, pollMs: 5 },
          )

          const { job } = yield* Queue.actions.enqueue('flaky', null)
          yield* until(function* () {
            return (yield* stateOf(job._id)) === 'dead'
          })
          const dead = (yield* Queue.actions.get(job._id))!
          expect(attempts).toEqual([1, 2, 3])
          expect(dead.attempts).toBe(3)
          expect(dead.last_error).toBe('test.flaky: boom 3')
          expect(worker.stats()).toMatchObject({ retried: 2, dead: 1 })

          // a per-job maxAttempts wins over the worker's
          const { job: once } = yield* Queue.actions.enqueue('flaky', null, { maxAttempts: 1 })
          yield* until(function* () {
            return (yield* stateOf(once._id)) === 'dead'
          })
          expect((yield* Queue.actions.get(once._id))!.attempts).toBe(1)

          healthy = true
          expect(yield* Queue.actions.retry(job._id)).toBe(true)
          yield* until(function* () {
            return (yield* stateOf(job._id)) === 'done'
          })
          expect((yield* Queue.actions.get(job._id))!.attempts).toBe(1)
          // only a dead/failed job can be retried
          expect(yield* Queue.actions.retry(job._id)).toBe(false)
        }),
      )
    })

    it('dedupeKey: one live job per key, re-armed only once finished', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()

          const first = yield* Queue.actions.enqueue('sync', { n: 1 }, { dedupeKey: 'ws-1' })
          const again = yield* Queue.actions.enqueue('sync', { n: 2 }, { dedupeKey: 'ws-1' })
          expect([first.op, again.op]).toEqual(['inserted', 'skipped'])
          expect(again.job._id).toBe(first.job._id)
          expect(again.job.payload).toEqual({ n: 1 })

          const payloads: unknown[] = []
          const worker = yield* Queue.actions.work(
            {
              *sync(job) {
                payloads.push(job.payload)
              },
            },
            { pollMs: 5 },
          )
          yield* until(function* () {
            return (yield* stateOf(first.job._id)) === 'done'
          })

          const rearmed = yield* Queue.actions.enqueue('sync', { n: 3 }, { dedupeKey: 'ws-1' })
          expect(rearmed.op).toBe('updated')
          expect(rearmed.job._id).toBe(first.job._id)
          expect(rearmed.job.attempts).toBe(0)
          yield* until(function* () {
            return payloads.length === 2
          })
          expect(payloads).toEqual([{ n: 1 }, { n: 3 }])
          yield* worker.halt()

          // concurrent enqueues of one key: exactly one live job
          const outcomes: string[] = []

          for (const entry of yield* all([
            Queue.actions.enqueue('sync', null, { dedupeKey: 'ws-2' }),
            Queue.actions.enqueue('sync', null, { dedupeKey: 'ws-2' }),
            Queue.actions.enqueue('sync', null, { dedupeKey: 'ws-2' }),
          ])) {
            outcomes.push(entry.op)
          }

          expect(outcomes.toSorted()).toEqual(['inserted', 'skipped', 'skipped'])
        }),
      )
    })

    it('priority orders the claim; runAt holds a job back until it is due', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const order: string[] = []
          const later = yield* Queue.actions.enqueue('step', 'later', {
            runAt: Date.now() + 150,
            priority: 100,
          })
          yield* Queue.actions.enqueue('step', 'low', { priority: 1 })
          yield* Queue.actions.enqueue('step', 'high', { priority: 9 })

          yield* Queue.actions.work(
            {
              *step(job) {
                order.push(String(job.payload))
              },
            },
            { pollMs: 1000 },
          )

          yield* until(function* () {
            return order.length === 2
          })
          expect(order).toEqual(['high', 'low'])
          expect(yield* stateOf(later.job._id)).toBe('queued')

          // the worker sleeps exactly until the delayed job is due (not the full poll)
          yield* until(function* () {
            return (yield* stateOf(later.job._id)) === 'done'
          }, 900)
          expect(order).toEqual(['high', 'low', 'later'])
        }),
      )
    })

    it('a lapsed lease (dead worker) is swept back and retried', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const db = yield* DbClient.context.expect()

          // what a crashed worker leaves behind: running, lease long gone
          const orphan = yield* (db as AnyType).insert('jobs', {
            kind: 'work',
            state: 'running',
            run_at: Date.now() - 1000,
            attempts: 1,
            lease_until: Date.now() - 500,
            worker: 'ghost',
          })

          const worker = yield* Queue.actions.work(
            {
              *work() {
                // done
              },
            },
            { pollMs: 5, leaseMs: 300, sweepMs: 10, backoff: () => 0 },
          )

          yield* until(function* () {
            return (yield* stateOf(orphan._id)) === 'done'
          })
          const row = (yield* Queue.actions.get(orphan._id))!
          expect(row.attempts).toBe(2)
          expect(row.worker).not.toBe('ghost')
          expect(worker.stats().swept).toBe(1)
        }),
      )
    })

    it('a running job keeps its lease alive; halting hands it back uncounted', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          let started = 0

          const worker = yield* Queue.actions.work(
            {
              *slow() {
                started += 1
                yield* sleep(10_000)
              },
            },
            { pollMs: 5, leaseMs: 60, sweepMs: 10 },
          )
          const { job } = yield* Queue.actions.enqueue('slow', null)

          // several lease periods pass: the heartbeat keeps the sweeper away
          yield* sleep(250)
          expect(started).toBe(1)
          const running = (yield* Queue.actions.get(job._id))!
          expect(running.state).toBe('running')
          expect(running.attempts).toBe(1)
          expect(worker.stats().swept).toBe(0)

          yield* worker.halt()
          const released = (yield* Queue.actions.get(job._id))!
          expect(released.state).toBe('queued')
          expect(released.attempts).toBe(0)
          expect(released.worker).toBeNull()
        }),
      )
    })

    it('several workers never run one attempt twice', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const runs = new Map<string, number>()
          const handlers = {
            *count(job: QueueDef.Job) {
              runs.set(job.id, (runs.get(job.id) ?? 0) + 1)
              yield* sleep(1)
            },
          }

          for (let index = 0; index < 30; index += 1) {
            yield* Queue.actions.enqueue('count', index)
          }

          yield* Queue.actions.work(handlers, { batch: 4, pollMs: 5 })
          yield* Queue.actions.work(handlers, { batch: 3, pollMs: 5 })
          yield* Queue.actions.work(handlers, { batch: 1, pollMs: 5 })

          yield* until(function* () {
            return (yield* Queue.actions.counts()).done === 30
          }, 5000)
          expect(runs.size).toBe(30)
          expect([...runs.values()].every(count => count === 1)).toBe(true)
        }),
      )
    })

    it('rejects bad wiring and bad arguments', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const empty = yield* attempt(Queue.actions.enqueue('', null))
          expect(isFailure(empty) && empty.error).toBe(QueueErrors.Validation)
          const priority = yield* attempt(Queue.actions.enqueue('x', null, { priority: 1.5 }))
          expect(isFailure(priority) && priority.error).toBe(QueueErrors.Validation)
          const noHandlers = yield* attempt(Queue.actions.work({}))
          expect(isFailure(noHandlers) && noHandlers.error).toBe(QueueErrors.Validation)
          const batch = yield* attempt(Queue.actions.work({ *x() {} }, { batch: 0 }))
          expect(isFailure(batch) && batch.error).toBe(QueueErrors.Validation)
        }),
      )

      // a table that is not a queue table
      const other = table('other', { title: column.text() })
      const wiring = await run(function* () {
        yield* target.use()
        yield* BunIO.use()
        yield* DbClient.use({ tables: [other] })
        yield* Queue.use({ table: 'other' })
      })
      expect(isFailure(wiring) && wiring.error).toBe(QueueErrors.Configuration)

      // no DbClient at all
      const bare = await run(function* () {
        yield* Queue.use({ table: 'jobs' })
      })
      expect(isFailure(bare) && bare.error).toBe(QueueErrors.Configuration)
    })
  })
}
