import { createServer, Edge } from 'server:core'
import { crud, Resource } from 'server:plugins'
import { run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todosTable } from '../helpers'

const json = function* (path: string, init?: RequestInit) {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text())
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

describe('resource', () => {
  it('crud: REST routes, sanitized filters, pagination, If-Match conflicts', async () => {
    const todos = crud(todosTable, { maxLimit: 2 })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
          // the deprecated Resource plugin is a NO-OP — installed here on purpose to prove
          // existing `Resource.use` calls keep booting (the socket comes from the service)
          plugins: [Resource.use({ resources: [todos] })],
        })
        yield* server.listen()
        const created = yield* json('/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'one', done: false }),
        })
        expect(created.status).toBe(200)
        expect(created.body).toMatchObject({ title: 'one', done: false })
        expect(typeof created.body._version).toBe('string')
        for (const title of ['two', 'three']) {
          yield* json('/todos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, done: true }),
          })
        }
        // invalid body (column kind) → validation before the db
        const invalid = yield* json('/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 1, done: 'x' }),
        })
        expect(invalid.status).toBe(400)

        // list with a JSON filter in the query string, clamped limit, cursor
        const page = yield* json(
          `/todos?filter=${encodeURIComponent(JSON.stringify({ op: 'eq', field: 'done', value: true }))}&limit=10`,
        )
        expect(page.status).toBe(200)
        expect(page.body.data).toHaveLength(2)
        expect(page.body.token).toBeTruthy()
        // a filter on a forbidden field is rejected
        const forbidden = yield* json(
          `/todos?filter=${encodeURIComponent(JSON.stringify({ op: 'eq', field: 'secret', value: 1 }))}`,
        )
        expect(forbidden.status).toBe(400)
        const all = yield* json('/todos?order=title&direction=asc')
        expect(all.body.data.map((row: AnyType) => row.title)).toEqual(['one', 'three'])
        expect(all.body.nextCursor).toBeTruthy()
        const next = yield* json(
          `/todos?order=title&direction=asc&cursor=${encodeURIComponent(all.body.nextCursor)}`,
        )
        expect(next.body.data.map((row: AnyType) => row.title)).toEqual(['two'])

        // get / update with If-Match / stale If-Match → 412 / remove
        const id = created.body._id
        expect((yield* json(`/todos/${id}`)).body.title).toBe('one')
        const updated = yield* json(`/todos/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'if-match': created.body._version },
          body: JSON.stringify({ done: true }),
        })
        expect(updated.status).toBe(200)
        expect(updated.body.done).toBe(true)
        const stale = yield* json(`/todos/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'if-match': created.body._version },
          body: JSON.stringify({ done: false }),
        })
        expect(stale.status).toBe(412)
        expect(stale.body.error.error).toBe('db.conflict')
        expect((yield* json(`/todos/${id}`, { method: 'DELETE' })).body).toEqual({ removed: true })
        expect((yield* json(`/todos/${id}`)).status).toBe(404)
        yield* server.stop()
      }),
    )
  })

  it('realtime: a socket watch syncs, streams deltas and resumes from a token', async () => {
    const todos = crud(todosTable)
    unwrap(
      await run(function* () {
        // a tiny replay window so a spaced `since` resume is provably current (silent)
        yield* storage({ replayWindowMs: 10 })
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
          plugins: [Resource.use({ resources: [todos] })],
        })
        const info = yield* server.listen({ port: 0 })
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/todos/_realtime`)
        // record EVERY frame continuously — silence assertions need eyes between reads
        const frames: AnyType[] = []
        ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
        const next = (after: number) =>
          until(
            new Promise<AnyType>((resolve, reject) => {
              const deadline = Date.now() + 3000
              const poll = () => {
                if (frames.length > after) {
                  resolve(frames[after])
                } else if (Date.now() > deadline) {
                  reject(new Error(`no frame ${after} — got ${JSON.stringify(frames)}`))
                } else {
                  setTimeout(poll, 10)
                }
              }
              poll()
            }),
          )
        yield* until(
          new Promise<void>(resolve => {
            ws.addEventListener('open', () => resolve())
          }),
        )
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w1',
            filter: { op: 'eq', field: 'done', value: false },
          }),
        )
        const sync = yield* next(0)
        expect(sync).toMatchObject({ t: 'sync', id: 'w1', rows: [] })
        yield* sleep(30)
        yield* server.call(todos.service, 'create', { title: 'live', done: false })
        const delta = yield* next(1)
        expect(delta.t).toBe('delta')
        expect(delta.added.map((row: AnyType) => row.title)).toEqual(['live'])
        // a row leaving the filter is a removal
        yield* sleep(30)
        yield* server.call(todos.service, 'update', {
          id: delta.added[0]._id,
          done: true,
        })
        const gone = yield* next(2)
        expect(gone.removed).toEqual([delta.added[0]._id])
        // resume from the last token: provably current → NO initial sync at all
        ws.send(JSON.stringify({ t: 'unwatch', id: 'w1' }))
        yield* sleep(30)
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w2',
            filter: { op: 'eq', field: 'done', value: false },
            since: gone.token,
          }),
        )
        yield* sleep(150)
        expect(frames.filter(frame => frame.id === 'w2')).toHaveLength(0)
        // the FIRST frame after a silent resume is a live diff — a `delta`, never a `sync`
        yield* server.call(todos.service, 'create', { title: 'after', done: false })
        const resumed = yield* next(3)
        expect(resumed.id).toBe('w2')
        expect(resumed.t).toBe('delta')
        expect(resumed.added.map((row: AnyType) => row.title)).toEqual(['after'])
        // a stale/garbage token self-heals with a FULL baseline sync
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w3',
            filter: { op: 'eq', field: 'done', value: false },
            since: 'garbage',
          }),
        )
        const healed = yield* next(4)
        expect(healed).toMatchObject({ t: 'sync', id: 'w3' })
        expect(healed.rows.map((row: AnyType) => row.title)).toEqual(['after'])
        ws.close()
        yield* server.stop()
      }),
    )
  })
})
