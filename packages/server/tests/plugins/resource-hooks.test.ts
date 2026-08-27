import { createServer, Edge, ServerErrors } from 'server:core'
import { crud } from 'server:plugins'
import { run, until } from 'std:effect'
import { appendCauses, fail, unwrap } from 'std:result'
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

const post = (path: string, body: unknown) =>
  json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('resource hooks', () => {
  it('before/after/around/error transform input, output and failures with the full ctx', async () => {
    const todos = crud(todosTable, {
      // input rewrite: every created title gains a bang BEFORE the handler stores it
      *before({ op, input }) {
        if (op === 'create') {
          return { ...(input as AnyType), title: `${(input as AnyType).title}!` }
        }
      },

      // output rewrite: list rows SHOUT, get rows are stamped
      *after({ op, output }) {
        const upper = (row: AnyType) => ({ ...row, title: row.title.toUpperCase() })
        if (op === 'list') {
          const page = output as AnyType
          return { ...page, data: page.data.map(upper) }
        }
        if (op === 'get') {
          return { ...(output as AnyType), title: `seen:${(output as AnyType).title}` }
        }
      },

      // full control: scope list to done=false via next(...), wrap get's (after-transformed)
      // output, and guard remove with a db read — a protected row never reaches the handler
      *around({ op, input, ctx }, next) {
        if (op === 'list') {
          return yield* next({
            ...(input as AnyType),
            filter: { op: 'eq', field: 'done', value: false },
          })
        }
        if (op === 'get') {
          const out = (yield* next(input)) as AnyType
          return { ...out, title: `${out.title}:wrapped` }
        }
        if (op === 'remove') {
          const row = yield* ctx.db.get('todos', (input as AnyType).id)
          if (row && String(row.title).includes('keep')) {
            return yield* fail(ServerErrors.Forbidden, 'protected row')
          }
        }
        return yield* next(input)
      },

      // failure shaping: get recovers with a stub row, update raises a REPLACED failure,
      // everything else keeps the original (with a cause appended)
      *error({ op, input, failure }) {
        if (op === 'get') {
          const now = new Date().toISOString()
          return {
            _id: String((input as AnyType).id),
            _created_at: now,
            _updated_at: now,
            _version: 'ghost',
            title: 'ghost',
            done: false,
            note: null,
          }
        }
        if (op === 'update') {
          return yield* fail(ServerErrors.BadRequest, 'update rewritten by hook')
        }
        return appendCauses(failure, 'hook:error saw it')
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
        })
        yield* server.listen()

        // before: input was rewritten before the insert
        const open = yield* post('/todos', { title: 'a', done: false })
        expect(open.status).toBe(200)
        expect(open.body.title).toBe('a!')
        yield* post('/todos', { title: 'b', done: true })

        // around(list) scopes to done=false, after(list) shouts — the client asked for ALL
        const page = yield* json('/todos')
        expect(page.body.data.map((row: AnyType) => row.title)).toEqual(['A!'])

        // after runs INSIDE around: get is stamped by after, then wrapped by around
        const got = yield* json(`/todos/${open.body._id}`)
        expect(got.body.title).toBe('seen:a!:wrapped')

        // error(get) RECOVERS the not-found with a stub row (it still passes the output schema)
        const ghost = yield* json('/todos/nope')
        expect(ghost.status).toBe(200)
        expect(ghost.body).toMatchObject({ _id: 'nope', title: 'ghost' })

        // error(update) REPLACES the not-found by raising a new failure
        const rewritten = yield* json('/todos/nope', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'x' }),
        })
        expect(rewritten.status).toBe(400)
        expect(rewritten.body.error.error).toBe(ServerErrors.BadRequest)
        expect(rewritten.body.error.message).toBe('update rewritten by hook')

        // around(remove) short-circuits on the guard — the row survives
        const guarded = yield* post('/todos', { title: 'keep me', done: false })
        const denied = yield* json(`/todos/${guarded.body._id}`, { method: 'DELETE' })
        expect(denied.status).toBe(403)
        expect((yield* json(`/todos/${guarded.body._id}`)).status).toBe(200)

        // an unguarded remove still works
        const removed = yield* json(`/todos/${open.body._id}`, { method: 'DELETE' })
        expect(removed.body).toEqual({ removed: true })
        yield* server.stop()
      }),
    )
  })

  it('realtime watch: before scopes the frame, after projects rows, error shapes the frame', async () => {
    const todos = crud(todosTable, {
      *before({ op, input }) {
        if (op !== 'watch') {
          return
        }
        const frame = input as AnyType
        if (frame.filter?.value === 'boom') {
          return yield* fail(ServerErrors.Forbidden, 'no boom')
        }
        // the tenancy seam: whatever the client asked for, this watch only sees done=false
        return { ...frame, filter: { op: 'eq', field: 'done', value: false } }
      },

      *after({ op, output }) {
        if (op !== 'watch') {
          return
        }
        const frame = output as AnyType
        const live = (row: AnyType) => ({ ...row, title: `live:${row.title}` })
        return frame.t === 'sync'
          ? { ...frame, rows: frame.rows.map(live) }
          : { ...frame, added: frame.added.map(live), changed: frame.changed.map(live) }
      },

      *error({ op, failure }) {
        if (op === 'watch') {
          return yield* fail(ServerErrors.BadRequest, `hook: ${failure.message}`)
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
        })
        const info = yield* server.listen({ port: 0 })
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/todos/_realtime`)
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
        yield* server.call(todos.service, 'create', { title: 'open', done: false })
        yield* server.call(todos.service, 'create', { title: 'closed', done: true })

        // the client watches EVERYTHING — before scopes it to done=false, after projects titles
        ws.send(JSON.stringify({ t: 'watch', id: 'w1' }))
        const sync = yield* next(0)
        expect(sync.t).toBe('sync')
        expect(sync.rows.map((row: AnyType) => row.title)).toEqual(['live:open'])

        yield* server.call(todos.service, 'create', { title: 'fresh', done: false })
        const delta = yield* next(1)
        expect(delta.t).toBe('delta')
        expect(delta.added.map((row: AnyType) => row.title)).toEqual(['live:fresh'])

        // a failing before ends in an error frame the error hook reshaped
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w2',
            filter: { op: 'eq', field: 'title', value: 'boom' },
          }),
        )
        const denied = yield* next(2)
        expect(denied).toMatchObject({
          t: 'error',
          id: 'w2',
          tag: ServerErrors.BadRequest,
          message: 'hook: no boom',
        })
        ws.close()
        yield* server.stop()
      }),
    )
  })
})
