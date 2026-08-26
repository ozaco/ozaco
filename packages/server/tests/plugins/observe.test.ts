import { DbAdapter } from 'db:core'
import { createServer, Edge, Observe } from 'server:core'
import { ObservePlugin } from 'server:plugins'
import { attempt, fork, run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

describe('observe — what happened is a db row', () => {
  it('an edge request captures redacted headers plus the input/output bodies', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [ObservePlugin.use({ batch: { ms: 10 } })],
        })
        yield* server.listen()

        const created = yield* Edge.actions.handle(
          new Request('http://edge/todos/create', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer sekrit',
              'x-tool': 'observe-test',
            },
            body: JSON.stringify({ title: 'captured' }),
          }),
        )
        expect(created.status).toBe(200)

        const streamed = yield* Edge.actions.handle(new Request('http://edge/todos/count?n=2'))
        yield* until(streamed.text())
        yield* sleep(30) // the streamed body's size patches the row after it closes

        const page = yield* Observe.actions.query({ service: 'todos' })
        const createRow = page.requests.find(row => row.action === 'create')!
        const countRow = page.requests.find(row => row.action === 'count')!

        // headers land redacted, never the bearer
        expect(createRow.headers).toMatchObject({ authorization: '•••', 'x-tool': 'observe-test' })

        // the value planes keep (capped) data
        expect(createRow.input).toMatchObject({
          kind: 'data',
          data: { title: 'captured' },
          truncated: false,
        })
        expect(createRow.output).toMatchObject({ kind: 'data' })
        expect((createRow.output!['data'] as { title: string }).title).toBe('captured')

        // a flow reply keeps its shape + the streamed SIZE, never its items
        expect(countRow.input).toMatchObject({ kind: 'data', data: { n: 2 } })
        expect(countRow.output).toMatchObject({ kind: 'flow', brand: 'ndjson' })
        expect(countRow.output!['size'] as number).toBeGreaterThan(0)

        yield* server.stop()
      }),
    )
  })

  it('a request leaves request/span/log/failure rows; request() assembles them; query() filters', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { ms: 10 } })],
        })
        yield* server.call(todos, 'create', { title: 'observed' })
        yield* attempt(server.call(todos, 'explode', { code: 'todo.kaput' }))
        yield* server.call(todos, 'nested', { title: 'deep' })

        const page = yield* Observe.actions.query({})
        expect(page.requests).toHaveLength(3)
        // newest first
        expect(page.requests.map(row => row.action)).toEqual(['nested', 'explode', 'create'])
        const failed = yield* Observe.actions.query({ status: 'failed' })
        expect(failed.requests).toHaveLength(1)
        expect(failed.requests[0]).toMatchObject({
          action: 'explode',
          error: 'todo.kaput',
          status: 500,
        })
        expect((yield* Observe.actions.query({ tag: 'todo.kaput' })).requests).toHaveLength(1)
        expect(
          (yield* Observe.actions.query({ service: 'todos', status: 'ok' })).requests,
        ).toHaveLength(2)

        // the create request: one dispatch span + one log line bound to it
        const created = page.requests.find(row => row.action === 'create')!
        const view = yield* Observe.actions.request(created.request_id)
        expect(view).not.toBeNull()
        expect(view!.spans.map(span => `${span.kind}:${span.name}:${span.status}`)).toEqual([
          'dispatch:todos.create:ok',
        ])
        expect(view!.logs).toHaveLength(1)
        expect(view!.logs[0]).toMatchObject({
          level: 'info',
          msg: 'creating',
          data: { title: 'observed' },
        })
        expect(view!.logs[0]!.span_id).toBe(view!.spans[0]!.span_id)

        // the failed one carries its failure row with the breadcrumb `where`
        const view2 = yield* Observe.actions.request(failed.requests[0]!.request_id)
        expect(view2!.failures).toHaveLength(1)
        expect(view2!.failures[0]).toMatchObject({
          tag: 'todo.kaput',
          where: 'dispatch:todos.explode',
        })

        // the nested one: two dispatch spans in a parent/child chain + an emit event
        const nested = page.requests.find(row => row.action === 'nested')!
        const view3 = yield* Observe.actions.request(nested.request_id)
        // spans come back in start order: the parent started first
        expect(view3!.spans.map(span => span.name)).toEqual(['todos.nested', 'todos.create'])
        const [outer, inner] = view3!.spans
        expect(inner!.parent_span_id).toBe(outer!.span_id)
        expect(view3!.events.map(event => `${event.kind}:${event.name}`)).toEqual([
          'emit:todo.created',
        ])
        expect(nested.lane).toBe('todos')

        const stats = yield* Observe.actions.stats()
        expect(stats.recorded).toBeGreaterThanOrEqual(9)
        expect(stats.dropped).toBe(0)
        expect(yield* Observe.actions.request('nope')).toBeNull()
      }),
    )
  })

  it('watch() streams requests as they finish; prune() forgets the old ones', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { ms: 10 } })],
        })
        const live = yield* Observe.actions.watch({ status: 'failed' })
        const seen = yield* fork(function* () {
          const step = yield* live.next()
          return step.value.map(row => row.action)
        })
        yield* sleep(30)
        yield* server.call(todos, 'create', { title: 'fine' })
        yield* attempt(server.call(todos, 'explode', { code: 'x' }))
        expect(yield* seen).toEqual(['explode'])

        expect((yield* Observe.actions.query()).requests).toHaveLength(2)
        yield* sleep(5)
        const removed = yield* Observe.actions.prune(Date.now() + 1)
        expect(removed).toBeGreaterThanOrEqual(4)
        expect((yield* Observe.actions.query()).requests).toHaveLength(0)
      }),
    )
  })

  it('a separate database keeps observability out of the app adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-observe-'))
    try {
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            plugins: [
              ObservePlugin.use({
                db: SqliteAdapter.use({ path: join(dir, 'observe.sqlite') }),
                batch: { ms: 10 },
              }),
            ],
          })
          yield* server.call(todos, 'create', { title: 'elsewhere' })
          expect((yield* Observe.actions.query()).requests).toHaveLength(1)
          // the app db never saw an observe table
          const tables = yield* DbAdapter.actions.tables()
          expect(tables.some((name: string) => name.startsWith('_ob_'))).toBe(false)
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
