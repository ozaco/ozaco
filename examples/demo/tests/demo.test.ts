import { createClient } from 'client:core'
import { attempt, createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLink } from 'transport:impl/memory'

import type { Api, DemoOptions, Step } from '../src'
import { createDemo, MCP_TOKEN, OBSERVE_TOKEN, walk } from '../src'

const detail = (steps: Step[], name: string): AnyType =>
  steps.find(step => step.name === name)?.detail

/** The observe console and its API answer admins and the ops bearer (`ObservePlugin.use({ auth })`). */
const OBSERVE_AUTH = { authorization: `Bearer ${OBSERVE_TOKEN}` }

describe('demo — every use case end to end', () => {
  it('boots the monolith and the typed client walks through it all', async () => {
    unwrap(
      await run(function* () {
        const app = yield* createDemo({ instance: 'mono' })
        const info = yield* app.start()

        expect(info.ready).toBe(true)

        const steps = yield* walk(info.url!)

        expect(detail(steps, 'manifest').services).toEqual([
          'account',
          'todos',
          'feed',
          'media',
          'reports',
          'jobs',
          'live',
          'rtc',
          'cluster',
          'observe',
        ])
        expect(detail(steps, 'manifest').sockets).toEqual([
          '/todos/_realtime',
          '/live/chat',
          '/rtc/:room',
        ])
        expect(detail(steps, 'whoami anonymous')).toBe('server.unauthorized')
        expect(detail(steps, 'login + whoami')).toMatchObject({ roles: ['admin'], type: 'access' })
        expect(detail(steps, 'refresh')).toEqual({ rotated: true })
        expect(detail(steps, 'refresh replay')).toBe('server.unauthorized')
        expect(detail(steps, 'admin-only promote')).toEqual({ ok: true })
        expect(detail(steps, 'todos crud')).toMatchObject({
          created: 'write the demo',
          updatedDone: true,
          staleWrite: 'db.conflict',
          listed: 1,
        })
        expect(detail(steps, 'realtime watch')).toEqual({ syncRows: 1, afterCreate: 2 })
        expect(detail(steps, 'crud hooks')).toEqual({
          trimmed: 'hooked',
          shouted: 'HOOKED',
          removeDenied: 'todos.protected',
          errorTagged: true,
        })
        expect(detail(steps, 'crud extend')).toEqual({
          stats: { low: 0, normal: 1, high: 0 },
          replaceDisabled: 'client.no-route',
        })
        expect(detail(steps, 'crud schema')).toEqual({ rejected: 'server.validation' })
        expect(detail(steps, 'crud ops')).toEqual({ open: ['seen live'], total: 1 })
        expect(detail(steps, 'streams')).toEqual({ ndjson: 3, sse: 2, text: 'a b c ', bytes: 4096 })
        expect(detail(steps, 'uploads')).toMatchObject({
          upload: 3000,
          ingest: 5000,
          listBefore: 0,
          listAfter: 1,
          downloaded: 3000,
          missing: 'media.not-found',
        })
        expect(detail(steps, 'cache')).toEqual({ hit: true, recomputedAfterInvalidate: true })

        const resilience = detail(steps, 'resilience')

        expect(resilience.retryAttempts).toBe(3)
        expect(resilience.fallback).toBe('fallback')
        expect(resilience.limited).toEqual([
          'ok',
          'ok',
          'ok',
          'server.rate-limited',
          'server.rate-limited',
        ])
        expect(resilience.breaker.slice(0, 3)).toEqual([
          'reports.boom',
          'reports.boom',
          'reports.boom',
        ])
        expect(resilience.breaker[3]).toBe('server.unavailable')
        expect(detail(steps, 'nested ctx.call')).toEqual({ todos: 2, uploads: 1 })
        expect(detail(steps, 'jobs reply shape')).toEqual({
          submitStatus: 202,
          location: true,
          state: 'done',
          missing: 'jobs.not-found',
          rpc: 'pong',
          softFailure: { tag: 'jobs.method-not-found', status: 'status:200' },
        })
        // a `fail` job: retried twice, then dead-lettered — its row keeps the whole cause chain
        expect(detail(steps, 'job queue')).toEqual({
          state: 'dead',
          attempts: 3,
          chain: ['jobs.job-failed', 'jobs.storage', 'jobs.disk-full'],
        })
        expect(detail(steps, 'static service token')).toEqual({
          userDenied: 'server.forbidden',
          pendingSeen: true,
          anonymousDenied: 'server.unauthorized',
        })
        expect(detail(steps, 'prefix search')).toEqual({
          upper: ['photo.bin'],
          wildcardIsLiteral: [],
        })

        // the 202 carries the per-call `location` header; the rpc failure is a 200 + `oz-error`
        const login = yield* until(
          fetch(`${info.url}/account/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'ada@example.com', password: 'ada' }),
          }),
        )
        const { accessToken } = (yield* until(login.json())) as AnyType
        const submit = yield* until(
          fetch(`${info.url}/jobs/submit`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ kind: 'report' }),
          }),
        )

        expect(submit.status).toBe(202)
        expect(submit.headers.get('cache-control')).toBe('no-store')
        expect(submit.headers.get('location')).toMatch(/^\/jobs\/status\//u)

        const rpc = yield* until(
          fetch(`${info.url}/jobs/rpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'nope' }),
          }),
        )

        expect(rpc.status).toBe(200)
        expect(rpc.headers.get('oz-error')).toBe('jobs.method-not-found')
        expect(((yield* until(rpc.json())) as AnyType).error.error).toBe('jobs.method-not-found')
        expect(detail(steps, 'events')).toEqual(['demo.ping'])
        expect(detail(steps, 'slow within deadline')).toMatchObject({ aborted: false })
        expect(detail(steps, 'cluster').servedBy).toBe('mono')
        expect(detail(steps, 'cluster').members.todos).toEqual(['mono'])
        expect(detail(steps, 'validation failure').tag).toBe('server.validation')
        expect(typeof detail(steps, 'last request id')).toBe('string')

        // the docs panel, the observe console (the ops bearer) and health answer on the edge
        for (const path of [
          '/docs',
          '/docs/manifest',
          '/_observe',
          '/_observe/api/cluster',
          '/_health',
          '/',
        ]) {
          const response = yield* until(fetch(`${info.url}${path}`, { headers: OBSERVE_AUTH }))

          expect([path, response.status]).toEqual([path, 200])
        }

        yield* app.stop()
      }),
    )
  })
})

describe('demo — the job queue', () => {
  it('each attempt is a root `process jobs` span linking the enqueue; one exception per attempt, the dead letter an ERROR with the whole chain', async () => {
    unwrap(
      await run(function* () {
        const app = yield* createDemo({ instance: 'queue' })
        const info = yield* app.start()
        const url = info.url!
        const client = yield* createClient<Api>({ url })
        const tokens = yield* client.account.login({ email: 'ada@example.com', password: 'ada' })

        client.$setToken(tokens.accessToken)

        const json = function* (path: string): Generator<AnyType, AnyType, AnyType> {
          const response = yield* until(fetch(`${url}${path}`, { headers: OBSERVE_AUTH }))

          return yield* until(response.json())
        }
        const settled = function* (id: string) {
          for (let tries = 0; tries < 100; tries += 1) {
            const job = yield* client.jobs.status({ id })

            if (job.state === 'done' || job.state === 'dead') {
              return job
            }

            yield* sleep(50)
          }

          throw new Error(`job ${id} never settled`)
        }

        const report = yield* settled((yield* client.jobs.submit({ kind: 'report' })).id)
        const doomed = yield* settled((yield* client.jobs.submit({ kind: 'fail' })).id)

        expect(report.state).toBe('done')
        expect(doomed).toMatchObject({ state: 'dead', attempts: 3 })

        // the node's own store — what every sink holds: 1 + 3 attempts, each a trace of its own
        const rootOf = (view: AnyType) => view.spans.find((span: AnyType) => span.root)
        // every attempt's trace is complete once its log records are in (the store flushes in
        // batches): each failed attempt's exception record, the `report` handler's line
        const complete = (view: AnyType) =>
          view.logs.some(
            (log: AnyType) =>
              log.event_name === 'messaging.process.exception' || log.body === 'report rendered',
          )
        let attempts: AnyType[] = []

        for (let tries = 0; tries < 60; tries += 1) {
          yield* sleep(50)

          const page = yield* json('/_observe/api/traces?name=process%20jobs&limit=50')

          attempts = []

          for (const root of page.traces) {
            attempts.push(yield* json(`/_observe/api/trace/${root.trace_id}`))
          }

          if (attempts.length >= 4 && attempts.every(complete)) {
            break
          }
        }

        const failing = attempts
          .filter(view => rootOf(view).attributes['messaging.message.id'] === doomed.id)
          .toSorted(
            (a, b) =>
              rootOf(a).attributes['ozaco.queue.attempt'] -
              rootOf(b).attributes['ozaco.queue.attempt'],
          )

        expect(failing.map(view => rootOf(view).attributes['ozaco.queue.attempt'])).toEqual([
          1, 2, 3,
        ])

        // every attempt LINKS the enqueue — a `send jobs` producer span inside the submit's trace
        const creation = rootOf(failing[0]).links.find(
          (link: AnyType) => link.attributes?.['ozaco.link.reason'] === 'creation',
        )
        const submit = yield* json(`/_observe/api/trace/${creation.context.traceId}`)
        const send = submit.spans.find((span: AnyType) => span.name === 'send jobs')

        expect(send).toMatchObject({ kind: 'producer', span_id: creation.context.spanId })
        expect(send.attributes).toMatchObject({
          'messaging.system': 'ozaco.queue',
          'messaging.message.id': doomed.id,
        })
        expect(submit.spans.map((span: AnyType) => span.name)).toContain('jobs.submit')

        for (const [index, view] of failing.entries()) {
          const root = rootOf(view)

          expect(root).toMatchObject({
            name: 'process jobs',
            kind: 'consumer',
            // a root of its own: it runs as the queue's service (`Queue.use({ service })`)
            service_name: 'jobs',
            error_type: 'jobs.job-failed',
            // a failure with attempts left is handled by the retry; the dead letter is an error
            status_code: index < 2 ? 'unset' : 'error',
          })

          const reasons = root.links.map((link: AnyType) => link.attributes?.['ozaco.link.reason'])

          expect(reasons).toContain('creation')

          if (index > 0) {
            // …and the previous attempt
            const retry = root.links.find(
              (link: AnyType) => link.attributes?.['ozaco.link.reason'] === 'queue.retry',
            )

            expect(retry.context.spanId).toBe(rootOf(failing[index - 1]).span_id)
          }

          // ONE exception per attempt: the span event on the origin + one log record, WARN while
          // retries are left, ERROR for the dead letter — the whole chain in both
          const exceptions = root.events.filter((event: AnyType) => event.name === 'exception')

          expect(exceptions).toHaveLength(1)
          expect(exceptions[0].attributes['ozaco.failure.chain']).toEqual([
            `jobs.job-failed: job ${doomed.id} failed (attempt ${index + 1}/3)`,
            `jobs.storage: cannot write the report of job ${doomed.id}`,
            `jobs.disk-full: no space left on device, write 'reports/${doomed.id}.pdf'`,
          ])

          const logs = view.logs.filter(
            (log: AnyType) => log.event_name === 'messaging.process.exception',
          )

          expect(logs).toHaveLength(1)
          expect(logs[0]).toMatchObject({
            span_id: root.span_id,
            severity_number: index < 2 ? 13 : 17,
          })
          expect(logs[0].body).toContain('Caused by: jobs.storage')
          expect(logs[0].body).toContain('Caused by: jobs.disk-full')
          expect(root.events.some((event: AnyType) => event.name === 'queue.dead')).toBe(
            index === 2,
          )
        }

        // the `report` attempt: its work nests under it, and the std Logger line the handler
        // wrote is a log record of that span (DefaultLogger → TraceTransport)
        const done = attempts.find(
          view => rootOf(view).attributes['messaging.message.id'] === report.id,
        )
        const worked = rootOf(done)

        expect(worked.status_code).toBe('unset')
        // …in the worker's own scope, the one its Logger line uses — never `@ozaco/std`
        expect(done.spans.find((span: AnyType) => span.name === 'render report')).toMatchObject({
          parent_span_id: worked.span_id,
          scope: 'demo/jobs',
        })

        // exactly ONE record per line (the demo's TraceTransport; `createServer` adds none)
        const lines = done.logs.filter((log: AnyType) => log.body === 'report rendered')

        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          span_id: worked.span_id,
          severity_number: 9,
          severity_text: 'INFO',
          scope: 'demo/jobs',
        })

        yield* app.stop()
      }),
    )
  }, 30_000)
})

describe('demo — the telemetry is not public', () => {
  it('`/_observe/api/*` answers admins and the ops bearer only; the console shell loads for all', async () => {
    unwrap(
      await run(function* () {
        const app = yield* createDemo({ instance: 'gated' })
        const info = yield* app.start()
        const client = yield* createClient<Api>({ url: info.url! })
        const login = function* (email: string, password: string) {
          return (yield* client.account.login({ email, password })).accessToken
        }
        const admin = yield* login('ada@example.com', 'ada')
        const user = yield* login('bob@example.com', 'bob')

        const statusOf = function* (path: string, token?: string) {
          const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

          return (yield* until(fetch(`${info.url}${path}`, { headers }))).status
        }

        // the page holds no data (it asks for a bearer when the API refuses it): public
        expect(yield* statusOf('/_observe')).toBe(200)

        for (const path of ['/_observe/api/cluster', '/_observe/api/traces?limit=1']) {
          expect({
            path,
            anonymous: yield* statusOf(path),
            // a valid bearer without the right: the MCP host's service token, a plain user
            service: yield* statusOf(path, MCP_TOKEN),
            user: yield* statusOf(path, user),
            ops: yield* statusOf(path, OBSERVE_TOKEN),
            admin: yield* statusOf(path, admin),
          }).toEqual({ path, anonymous: 401, service: 403, user: 403, ops: 200, admin: 200 })
        }

        yield* app.stop()
      }),
    )
  })
})

describe('demo — failures reach the terminal', () => {
  it('a recorded failure prints through the std Logger the demo installs (ConsoleTransport)', async () => {
    // the terminal is `console` (ConsoleTransport writes WARN to `warn`, ERROR to `error`)
    const printed: string[] = []
    const { error, warn } = console
    const capture = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    const boomed = () => printed.some(line => line.includes('reports.boom'))
    let traceId = null as string | null

    console.error = capture
    console.warn = capture

    try {
      unwrap(
        await run(function* () {
          const app = yield* createDemo({ instance: 'loud' })
          const info = yield* app.start()
          const client = yield* createClient<Api>({ url: info.url! })

          // a 500 the node records — its exception must not stay in the telemetry alone
          const failed = (yield* attempt(client.reports.guarded({ boom: true }))) as AnyType

          expect(failed.error).toBe('reports.boom')
          traceId = client.$lastTraceId()

          for (let tries = 0; tries < 40 && !boomed(); tries += 1) {
            yield* sleep(25)
          }

          yield* app.stop()
        }),
      )
    } finally {
      console.error = error
      console.warn = warn
    }

    expect(boomed()).toBe(true)

    // ONE line, correlated to the request's trace, the failure on it once (a one-line failure
    // rides `err=`, no chain block repeats it)
    const lines = printed.filter(line => line.includes('reports.boom'))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(` trace=${traceId?.slice(0, 8)}`)
    expect(lines[0]!.split('reports.boom')).toHaveLength(2)
  })
})

describe('demo — cluster', () => {
  it('gateway + two service nodes over one link: calls route by presence, observe rows collect', async () => {
    const link = createLink()
    // one database for the cluster (a file every node opens), the bus on the shared link
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ozaco-demo-')), 'demo.sqlite')

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const node = (options: DemoOptions) =>
          fork(() =>
            scoped(function* () {
              const app = yield* createDemo({ ...options, dbPath, link })

              yield* app.start()
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )
        const api1 = yield* node({
          role: 'service',
          hosted: ['account', 'todos', 'media'],
          instance: 'api-1',
          observe: 'forward',
        })
        const api2 = yield* node({
          role: 'service',
          hosted: ['feed', 'reports', 'jobs', 'live', 'rtc', 'cluster'],
          instance: 'api-2',
          observe: 'forward',
        })

        yield* ready.next()
        yield* ready.next()

        const gateway = yield* createDemo({
          role: 'gateway',
          instance: 'gw',
          observe: 'collect',
          dbPath,
          link,
        })
        const info = yield* gateway.start()

        expect(info).toMatchObject({ role: 'gateway', hosted: [], ready: true })

        const steps = yield* walk(info.url!)

        expect(detail(steps, 'cluster').servedBy).toBe('api-2')
        expect(detail(steps, 'cluster').members).toMatchObject({
          todos: ['api-1'],
          feed: ['api-2'],
        })
        expect(detail(steps, 'streams')).toEqual({ ndjson: 3, sse: 2, text: 'a b c ', bytes: 4096 })
        expect(detail(steps, 'uploads')).toMatchObject({
          upload: 3000,
          ingest: 5000,
          downloaded: 3000,
        })
        expect(detail(steps, 'nested ctx.call')).toEqual({ todos: 2, uploads: 1 })
        // the queue is rows of the shared sqlite file: a job submitted through the gateway is
        // enqueued and worked on api-2 (the node hosting `jobs`), its status read back anywhere
        // the owner's reply headers cross the carrier: api-2 set `location`, the gateway answers it
        expect(detail(steps, 'jobs reply shape')).toMatchObject({
          submitStatus: 202,
          location: true,
          state: 'done',
        })
        expect(detail(steps, 'job queue')).toMatchObject({ state: 'dead', attempts: 3 })
        expect(detail(steps, 'static service token')).toMatchObject({ pendingSeen: true })
        expect(detail(steps, 'realtime watch')).toEqual({ syncRows: 1, afterCreate: 2 })
        // the hooks run on the node HOSTING todos (api-1), not on the gateway
        expect(detail(steps, 'crud hooks')).toMatchObject({ trimmed: 'hooked', shouted: 'HOOKED' })
        // the extend action routes over the carrier like any other todos action
        expect(detail(steps, 'crud extend')).toMatchObject({ stats: { normal: 1 } })

        // the gateway's observe store holds the service nodes' spans (forward → collect)
        yield* sleep(300)

        const clusterView = yield* until(
          fetch(`${info.url}/_observe/api/cluster`, { headers: OBSERVE_AUTH }),
        )
        const view = (yield* until(clusterView.json())) as AnyType

        expect(view.instances.map((entry: AnyType) => entry.instance).toSorted()).toEqual([
          'api-1',
          'api-2',
          'gw',
        ])

        const health = (yield* until(
          (yield* until(fetch(`${info.url}/_health`))).json(),
        )) as AnyType

        expect(health.members.todos.map((member: AnyType) => member.instance)).toEqual(['api-1'])

        yield* gateway.stop()
        yield* api1.halt()
        yield* api2.halt()
      }),
    )
  })
})
