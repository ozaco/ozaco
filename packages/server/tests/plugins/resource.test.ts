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
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
          plugins: [Resource.use({ resources: [todos] })],
        })
        const info = yield* server.listen({ port: 0 })
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/todos/_realtime`)
        const frames: AnyType[] = []
        const next = () =>
          until(
            new Promise<AnyType>(resolve => {
              const listener = (event: MessageEvent) => {
                ws.removeEventListener('message', listener)
                const frame = JSON.parse(String(event.data))
                frames.push(frame)
                resolve(frame)
              }
              ws.addEventListener('message', listener)
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
        const sync = yield* next()
        expect(sync).toMatchObject({ t: 'sync', id: 'w1', rows: [] })
        yield* server.call((server.api as AnyType).todos.create, { title: 'live', done: false })
        const delta = yield* next()
        expect(delta.t).toBe('delta')
        expect(delta.added.map((row: AnyType) => row.title)).toEqual(['live'])
        // a row leaving the filter is a removal
        yield* server.call((server.api as AnyType).todos.update, {
          id: delta.added[0]._id,
          done: true,
        })
        const gone = yield* next()
        expect(gone.removed).toEqual([delta.added[0]._id])
        // resume from the last token: nothing happened since → no initial sync at all
        ws.send(JSON.stringify({ t: 'unwatch', id: 'w1' }))
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w2',
            filter: { op: 'eq', field: 'done', value: false },
            since: gone.token,
          }),
        )
        yield* sleep(100)
        expect(frames.filter(frame => frame.id === 'w2')).toHaveLength(0)
        yield* server.call((server.api as AnyType).todos.create, { title: 'after', done: false })
        const resumed = yield* next()
        expect(resumed.id).toBe('w2')
        expect(resumed.added.map((row: AnyType) => row.title)).toEqual(['after'])
        ws.close()
        yield* server.stop()
      }),
    )
  })
})
