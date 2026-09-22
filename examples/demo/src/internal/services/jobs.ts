/**
 * Jobs: the reply-shape and auth options in one place — a `202 Accepted` submit with a
 * `location` header set per call (`ctx.reply`), a status lookup, a service-only listing behind
 * a STATIC token (`StaticAuth.use({ tokens })`, no login), a service-level `auth` default with one
 * action opting out, and an rpc-style action whose domain failure travels as a 200. Job records
 * live in the `Kv` — here `TableKv`, rows of the demo's sqlite, shared by every node.
 */
import { Kv } from 'db:core'
import { action, service } from 'server:core'
import { IO } from 'std:io'

import { z } from 'zod'

import { jobsErrors } from '../../errors'

const Job = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.enum(['queued', 'done']),
  submittedAt: z.number(),
})

type Job = z.infer<typeof Job>

const JOB_TTL_MS = 60_000

export const jobs = service(
  'jobs',
  {
    submit: action.mutation(
      {
        input: z.object({ kind: z.string().min(1) }),
        output: Job,
        // the reply shape: a static status + static header, the location added per call
        status: 202,
        headers: { 'cache-control': 'no-store' },
        description: 'Queue a job: 202 Accepted with a `location` header pointing at its status',
      },
      function* ({ input, ctx }) {
        const job: Job = {
          id: yield* IO.actions.ulid(),
          kind: input.kind,
          state: 'queued',
          submittedAt: Date.now(),
        }
        yield* Kv.actions.set(`job:${job.id}`, job, { ttlMs: JOB_TTL_MS, tags: ['jobs'] })
        ctx.reply({ headers: { location: `/jobs/status/${job.id}` } })
        return job
      },
    ),
    status: action.query(
      {
        input: z.object({ id: z.string() }),
        output: Job,
        route: { method: 'GET', path: '/jobs/status/:id' },
        errors: jobsErrors.statuses,
        description: 'The job behind a `location` header',
      },
      function* ({ input }) {
        const job = yield* Kv.actions.get<Job>(`job:${input.id}`)
        return job ?? (yield* jobsErrors.notFound(`no job ${input.id}`))
      },
    ),
    pending: action.query(
      {
        input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
        output: z.object({ ids: z.array(z.string()), more: z.boolean() }),
        // a SERVICE token only: the static `demo-mcp-token` of `StaticAuth.use({ tokens })`
        auth: 'service',
        description:
          'Queued job ids (a Kv prefix scan) — for another system holding a service token',
      },
      function* ({ input }) {
        const page = yield* Kv.actions.keys('job:', { limit: input.limit })
        return { ids: page.keys.map(key => key.slice('job:'.length)), more: page.cursor !== null }
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
    description: 'Reply shapes (202 + location), static service tokens, rpc-style failures',
    // every action needs a caller unless it says otherwise (`rpc` opens itself up)
    auth: 'authenticated',
  },
)
