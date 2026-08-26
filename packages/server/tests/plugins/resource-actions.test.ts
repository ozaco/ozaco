import { action, createServer, Edge } from 'server:core'
import { crud, Resource } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

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

describe('resource actions + extend', () => {
  it('actions picks the built-ins (realtime included), extend adds custom actions unhooked', async () => {
    const todos = crud(todosTable, {
      actions: ['list', 'create'],

      extend: {
        stats: action.query({ output: z.object({ open: z.number() }) }, function* ({ ctx }) {
          const rows = yield* ctx.db.query('todos').collect()
          return { open: rows.filter(row => row.done === false).length }
        }),
      },

      // hooks wrap the BUILT-INS only — `stats` must come through untouched
      *after({ op, output }) {
        const upper = (row: AnyType) => ({ ...row, title: row.title.toUpperCase() })
        if (op === 'list') {
          const page = output as AnyType
          return { ...page, data: page.data.map(upper) }
        }
      },
    })

    expect(todos.actions).toEqual(['list', 'create'])

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
          plugins: [Resource.use({ resources: [todos] })],
        })
        yield* server.listen()

        // the enabled built-ins answer
        const created = yield* json('/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'one', done: false }),
        })
        expect(created.status).toBe(200)
        const page = yield* json('/todos')
        expect(page.body.data.map((row: AnyType) => row.title)).toEqual(['ONE'])

        // the custom action lives on the SAME service — its static route beats `/:id`,
        // and the after hook did not touch it
        const stats = yield* json('/todos/stats')
        expect(stats.status).toBe(200)
        expect(stats.body).toEqual({ open: 1 })

        // the excluded built-ins do not exist: no route, nothing to call
        expect((yield* json(`/todos/${created.body._id}`)).status).toBe(404)
        expect((yield* json(`/todos/${created.body._id}`, { method: 'DELETE' })).status).toBe(404)
        expect(
          (yield* json(`/todos/${created.body._id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ done: true }),
          })).status,
        ).toBe(404)

        // no 'realtime' in `actions` → the socket route is not mounted
        expect((yield* json('/todos/_realtime')).status).toBe(404)
        yield* server.stop()
      }),
    )
  })

  it('omitted actions (or true) enables everything, and the resolved set is carried', async () => {
    const everything = crud(todosTable)
    const explicit = crud(todosTable, { name: 'todos2', actions: true })
    expect(everything.actions).toEqual([
      'list',
      'get',
      'create',
      'update',
      'replace',
      'remove',
      'realtime',
    ])
    expect(explicit.actions).toEqual(everything.actions)

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [everything.service],
          edge: BunEdge,
          plugins: [Resource.use({ resources: [everything] })],
        })
        const info = yield* server.listen({ port: 0 })

        // the realtime socket IS mounted by default
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/todos/_realtime`)
        const opened = yield* until(
          new Promise<boolean>(resolve => {
            ws.addEventListener('open', () => resolve(true))
            ws.addEventListener('error', () => resolve(false))
          }),
        )
        expect(opened).toBe(true)
        ws.close()
        yield* server.stop()
      }),
    )
  })
})
