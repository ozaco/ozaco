/**
 * Failures RETURNED as responses (never raised through a span) still land in the observe
 * plane: unrouted 404s, rejected upgrades, input validation — each reports a `failure` row,
 * so exporters (OTLP, OpenObserve) and the console see them. Raised handler failures keep
 * reporting through `withSpan` — exactly once, no doubles.
 */
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import { crud } from 'server:plugins'
import { run, sleep, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todosTable } from '../helpers'

const probe = (url: string): Promise<'open' | 'rejected'> =>
  new Promise(resolve => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => {
      ws.close()
      resolve('open')
    })
    ws.addEventListener('error', () => resolve('rejected'))
    ws.addEventListener('close', event => {
      if (event.code !== 1000) {
        resolve('rejected')
      }
    })
  })

describe('edge — returned failures are reported', () => {
  it('404 route, bad input, socket reject and raised failures each land exactly once', async () => {
    const failures: AnyType[] = []
    const Spy = definePlugin<ServerDef.PluginContext, []>({
      name: 'spy',
      version: '0',
      description: 'captures observe failure rows',
      *setup() {
        const hooks: ServerDef.Hooks = {
          name: 'spy',
          *observe(event) {
            if (event.t === 'failure') {
              failures.push(event.row)
            }
          },
        }
        return { hooks }
      },
    }).build()

    unwrap(
      await run(function* () {
        yield* storage()
        const todos = crud(todosTable)
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Spy.use()],
        })
        yield* Edge.actions.socket({
          path: '/guarded',
          *authorize() {
            return yield* fail('server.unauthorized', 'no way in')
          },
          *handler() {},
        })
        const info = yield* server.start({ port: 0 })
        const base = info.url!

        // an unrouted request → failure row with the http status
        expect((yield* until(fetch(`${base}/nope`))).status).toBe(404)

        // an unparseable body → failure row anchored to the action (edge input plane)
        const unparseable = yield* until(
          fetch(`${base}/todos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
          }),
        )
        expect(unparseable.status).toBe(400)

        // a WRONGLY TYPED body raises inside dispatch — reported there by withSpan
        const invalid = yield* until(
          fetch(`${base}/todos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 1, done: 'x' }),
          }),
        )
        expect(invalid.status).toBe(400)

        // socket: unknown path + rejected authorize
        const wsBase = base.replace('http', 'ws')
        expect(yield* until(probe(`${wsBase}/no-socket`))).toBe('rejected')
        expect(yield* until(probe(`${wsBase}/guarded`))).toBe('rejected')

        // a RAISED handler failure keeps its single withSpan report (no double)
        expect((yield* until(fetch(`${base}/todos/00000000000000000000000000000000`))).status).toBe(
          404,
        )

        yield* sleep(50)

        // /nope + the unknown ws path (Bun never upgrades an unrouted socket — it falls
        // through to HTTP and 404s as a plain route miss)
        const notFound = failures.filter(row => row.where === 'edge:route')
        expect(notFound).toHaveLength(2)
        expect(notFound[0]).toMatchObject({ tag: 'server.not-found', status: 404 })

        const badInput = failures.filter(row => String(row.where).startsWith('edge:input'))
        expect(badInput).toHaveLength(1)
        expect(badInput[0].status).toBe(400)

        const validation = failures.filter(
          row => row.where === 'dispatch:todos.create' && row.tag === 'server.validation',
        )
        expect(validation).toHaveLength(1)

        const guarded = failures.filter(row => row.where === 'edge:socket /guarded')
        expect(guarded).toHaveLength(1)
        expect(guarded[0]).toMatchObject({ tag: 'server.unauthorized', status: 401 })

        // the raised db not-found: exactly ONE row, from the dispatch span
        const raised = failures.filter(row => String(row.where) === 'dispatch:todos.get')
        expect(raised).toHaveLength(1)

        yield* server.stop()
      }),
    )
  })
})
