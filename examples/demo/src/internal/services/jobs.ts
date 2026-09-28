// oxlint-disable import/exports-last
/**
 * Jobs: a durable queue (`@ozaco/db/queue` — rows of the demo's sqlite, shared by every node)
 * behind the reply-shape and auth options — a `202 Accepted` submit (an enqueue) with a
 * `location` header set per call (`ctx.reply`), a status lookup (the job row), a service-only
 * listing behind a STATIC token (`StaticAuth.use({ tokens })`, no login), a service-level `auth`
 * default with one action opting out, and an rpc-style action whose domain failure travels as a
 * 200.
 *
 * The WORKER (`JobsWorker`) starts in a server start hook on the node that hosts `jobs` and stops
 * with it. Kind `report` does a little traced work; kind `fail` fails on purpose with a
 * three-level cause chain (the job → the storage step → the platform fault, classified by the
 * `workerErrors` matcher), so the queue's telemetry is there to look at: the enqueue is a
 * `send jobs` producer span inside the submit's trace, every attempt a ROOT `process jobs`
 * consumer span LINKING it (and the previous attempt), an attempt with retries left records its
 * failure WARN, the dead letter ERROR with the span event `queue.dead` — and the row's
 * `last_error` keeps the whole chain.
 */
import { useDb, where } from 'db:core'
import type { QueueDef } from 'db:queue'
import { Queue } from 'db:queue'
import type { ServerDef } from 'server:core'
import { action, Server, service } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, sleep } from 'std:effect'
import { Logger } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { asFailure, fail, isFailure } from 'std:result'
import { Trace } from 'std:trace'

import { z } from 'zod'

import { jobsErrors, workerErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import { schema } from '../../utils/tables'

/** What the worker runs — the only kinds `submit` takes. */
const Kind = z.enum(['report', 'fail'])

export const Job = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed', 'dead']),
  attempts: z.number().int(),
  submittedAt: z.number(),
  /** the last failed attempt's whole cause chain (`formatFailure(f, { chain: true })`). */
  lastError: z.string().nullable(),
})

/** Retry quickly so a failing job is dead-lettered within a second: attempts at 0, +100, +200 ms. */
const WORK: QueueDef.WorkOptions = {
  maxAttempts: 3,
  backoff: { kind: 'exponential', baseMs: 100, maxMs: 2000 },
}

/** How long a `report` job "renders". */
const REPORT_MS = 20

/** Jobs not settled yet — what `pending` lists. */
const LIVE: readonly QueueDef.State[] = ['queued', 'running', 'failed']

const jobOf = (row: QueueDef.Row): Helpers.Job => ({
  id: row._id,
  kind: row.kind,
  state: row.state,
  attempts: row.attempts,
  submittedAt: row._created_at,
  lastError: row.last_error,
})

/** The worker's instrumentation scope — its Logger lines and its own spans alike. */
const JOBS_SCOPE = 'demo/jobs'

/** A worker line through the std Logger — correlated to the attempt's `process jobs` span. */
const log = (msg: string, data: Record<string, unknown>) =>
  Logger.actions.child({ logger: JOBS_SCOPE }, () => Logger.actions.info(msg, data))

/**
 * The platform fault a `fail` job runs into: what a full disk rejects a write with (its `code` and
 * `message`), folded by the `workerErrors` matcher into `jobs.disk-full` (the value kept as its
 * `raw`) under the storage step that ran into it.
 */
function* writeReport(id: string): Operation<never> {
  const rejected = { code: 'ENOSPC', message: `no space left on device, write 'reports/${id}.pdf'` }

  return yield* fail(
    workerErrors.Storage,
    `cannot write the report of job ${id}`,
    asFailure(rejected, workerErrors),
  )
}

/** The handlers by kind: a succeed → `done`, a failure → a retry, then the dead letter. */
const handlers = {
  *report(job: QueueDef.Job) {
    // the work nests under the attempt's `process jobs` span, in the scope its Logger line uses
    // (none given, it would be the span's service — `jobs` — never `@ozaco/std`)
    yield* Trace.actions.span('render report', { scope: { name: JOBS_SCOPE } }, function* () {
      yield* sleep(REPORT_MS)
    })
    yield* log('report rendered', { 'job.id': job.id, 'job.attempt': job.attempt })
  },

  *fail(job: QueueDef.Job) {
    const written = yield* attempt(() => writeReport(job.id))

    if (isFailure(written)) {
      // the storage failure nested as it is — the chain the dead letter keeps
      return yield* fail(
        workerErrors.JobFailed,
        `job ${job.id} failed (attempt ${job.attempt}/${job.maxAttempts})`,
        written,
      )
    }
  },
} satisfies Record<z.infer<typeof Kind>, QueueDef.Handler>

/**
 * The queue's worker, as a server plugin: its START hook starts it on the node that hosts `jobs`
 * (a gateway or another service node only enqueues through the carrier), its stop hook halts it —
 * in-flight jobs go back to `queued`. The worker lives in the scope `start()` runs in, after
 * `createServer` installed the node's tracer, so every attempt is recorded.
 */
export const JobsWorker = definePlugin<ServerDef.PluginContext, []>({
  name: 'demo-jobs-worker',
  version: '1.0.0',
  description: 'Runs the jobs queue on the node hosting the `jobs` service',

  *setup() {
    const kernel = yield* Server.context.expect()
    let worker: QueueDef.Worker | null = null

    return {
      hooks: {
        name: 'demo-jobs-worker',

        *start() {
          if (kernel.hosted.has('jobs') && worker === null) {
            worker = yield* Queue.actions.work(handlers, WORK)
          }
        },

        *stop() {
          const running = worker

          worker = null

          if (running) {
            yield* running.halt()
          }
        },
      },
    }
  },
}).build()

export const jobs = service(
  'jobs',
  {
    submit: action.mutation(
      {
        input: z.object({
          kind: Kind,
          /** not before this many ms from now (a scheduled job). */
          delayMs: z.number().int().min(0).max(86_400_000).optional(),
        }),
        output: Job,
        // the reply shape: a static status + static header, the location added per call
        status: 202,
        headers: { 'cache-control': 'no-store' },
        description:
          'Queue a job (`report` works, `fail` is dead-lettered after 3 attempts): 202 Accepted with a `location` header pointing at its status',
      },
      function* ({ input, ctx }) {
        const { job } = yield* Queue.actions.enqueue(
          input.kind,
          { by: ctx.auth?.sub ?? null },
          input.delayMs === undefined ? {} : { runAt: Date.now() + input.delayMs },
        )

        ctx.reply({ headers: { location: `/jobs/status/${job._id}` } })

        return jobOf(job)
      },
    ),
    status: action.query(
      {
        input: z.object({ id: z.string() }),
        output: Job,
        route: { method: 'GET', path: '/jobs/status/:id' },
        errors: jobsErrors.statuses,
        description: 'The job behind a `location` header — its state, attempts and last failure',
      },
      function* ({ input }) {
        const row = yield* Queue.actions.get(input.id)

        return row ? jobOf(row) : yield* jobsErrors.notFound(`no job ${input.id}`)
      },
    ),
    pending: action.query(
      {
        input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
        output: z.object({ ids: z.array(z.string()), more: z.boolean() }),
        // a SERVICE token only: the static `demo-mcp-token` of `StaticAuth.use({ tokens })`
        auth: 'service',
        description:
          'Unsettled job ids (queued, running, waiting for a retry), due first — for another system holding a service token',
      },
      function* ({ input }) {
        const rows = yield* (yield* useDb(schema))
          .query('jobs')
          .filter(where.oneOf('state', LIVE))
          .order('run_at')
          .take(input.limit + 1)

        return {
          ids: rows.slice(0, input.limit).map(row => row._id),
          more: rows.length > input.limit,
        }
      },
    ),
    rpc: action.mutation(
      {
        input: z.object({ method: z.string(), params: z.unknown().optional() }),
        output: z.object({ result: z.unknown() }),
        // opts OUT of the service-level `auth`
        auth: false,
        errors: jobsErrors.statuses,
        description:
          'JSON-RPC style: an unknown method is a FAILURE delivered as a 200 with the error envelope',
      },
      function* ({ input }) {
        switch (input.method) {
          case 'ping': {
            return { result: 'pong' }
          }

          case 'echo': {
            return { result: input.params ?? null }
          }

          default: {
            return yield* jobsErrors.methodNotFound(`no method ${input.method}`)
          }
        }
      },
    ),
  },
  {
    version: '1.0.0',
    description:
      'A durable job queue (202 + location, a worker, a dead letter), static service tokens, rpc-style failures',
    // every action needs a caller unless it says otherwise (`rpc` opens itself up)
    auth: 'authenticated',
  },
)
