import { column, DbClient, defineSchema, table, useDb, where } from 'db:core'
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import { Auth, crud } from 'server:plugins'
import type { Operation } from 'std:effect'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'

const notesTable = table('notes', {
  tenant: column.text(),
  title: column.text(),
  done: column.boolean().default(false),
}).index('by_tenant', ['tenant'])

const notesSchema = defineSchema({ notesTable })

function* storage(): Operation<void> {
  yield* MemoryAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ schema: notesSchema })
  yield* MemoryKv.use()
}

/** The test's stand-in for a verified caller: the `x-tenant` header (the HTTP legs), or the
 * socket ctx's verified principal (the realtime leg — the in-band auth frame resolves it). */
const tenantOf = (ctx: ServerDef.Ctx): string | undefined =>
  ctx.headers['x-tenant'] ?? ctx.auth?.sub

const notes = crud(notesTable, {
  // the tenancy seam: no hook can widen it, and it applies to every built-in
  *scope(ctx) {
    return where.eq('tenant', tenantOf(ctx) ?? '\u0000-no-tenant')
  },

  // the recommended pairing: the scoped column leaves the create shape — the scope fills it
  schema: { create: s => s.omit({ tenant: true }) },
})

const json = function* (path: string, tenant: string | undefined, init?: RequestInit) {
  const response = yield* Edge.actions.handle(
    new Request(`http://edge${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(tenant === undefined ? {} : { 'x-tenant': tenant }),
        ...init?.headers,
      },
    }),
  )
  const text = yield* until(response.text())

  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const seed = function* (tenant: string, title: string) {
  const db = yield* useDb(notesSchema)
  return yield* db.insert('notes', { tenant, title, done: false })
}

describe('resource scope', () => {
  it('scopes every built-in read and guards every built-in write', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], edge: BunEdge })
        yield* server.start()

        const mine = yield* seed('a', 'mine')
        const theirs = yield* seed('b', 'theirs')

        // list: only the caller's rows, whatever the client filter says
        const page = yield* json('/notes', 'a')
        expect(page.body.data.map((row: AnyType) => row.title)).toEqual(['mine'])

        // get: another tenant's row reads as absent, not as forbidden
        expect((yield* json(`/notes/${mine._id}`, 'a')).status).toBe(200)
        expect((yield* json(`/notes/${theirs._id}`, 'a')).status).toBe(404)

        // create: the scope stamps the column the create shape no longer carries
        const created = yield* json('/notes', 'a', {
          method: 'POST',
          body: JSON.stringify({ title: 'fresh', done: false }),
        })
        expect(created.status).toBe(200)
        expect(created.body.tenant).toBe('a')

        // update: another tenant's row is a MISS (404), never a conflict that proves it exists
        const patch = (
          id: string,
          tenant: string,
          write: { readonly body: unknown; readonly ifMatch?: string },
        ) =>
          json(`/notes/${id}`, tenant, {
            method: 'PATCH',
            body: JSON.stringify(write.body),
            ...(write.ifMatch === undefined ? {} : { headers: { 'if-match': write.ifMatch } }),
          })

        expect((yield* patch(theirs._id, 'a', { body: { title: 'stolen' } })).status).toBe(404)
        expect(
          (yield* patch(theirs._id, 'a', { body: { title: 'stolen' }, ifMatch: 'v:stale' })).status,
        ).toBe(404)
        expect((yield* json(`/notes/${theirs._id}`, 'b')).body.title).toBe('theirs')

        // an in-scope stale If-Match still conflicts — the guard did not swallow the gate
        expect(
          (yield* patch(mine._id, 'a', { body: { title: 'x' }, ifMatch: 'v:stale' })).status,
        ).toBe(412)

        // update: the scoped column is not the caller's to move
        const moved = yield* patch(mine._id, 'a', { body: { title: 'kept', tenant: 'b' } })
        expect(moved.status).toBe(200)
        expect(moved.body.tenant).toBe('a')

        // replace: same — the scope re-stamps the replacement
        const replaced = yield* json(`/notes/${mine._id}`, 'a', {
          method: 'PUT',
          body: JSON.stringify({ title: 'put', done: true, tenant: 'b' }),
        })
        expect(replaced.status).toBe(200)
        expect(replaced.body.tenant).toBe('a')
        expect((yield* json(`/notes/${mine._id}`, 'a')).status).toBe(200)

        // remove: another tenant's row is simply not there
        expect((yield* json(`/notes/${theirs._id}`, 'a', { method: 'DELETE' })).body).toEqual({
          removed: false,
        })
        expect((yield* json(`/notes/${theirs._id}`, 'b')).status).toBe(200)

        // no tenant at all sees nothing
        expect((yield* json('/notes', undefined)).body.data).toEqual([])
        yield* server.stop()
      }),
    )
  })

  it('scopes the realtime watch — under whatever the client subscribes to', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [notes],
          edge: BunEdge,
          plugins: [
            Auth.use({
              secret: 'scope-test',
              provider: {
                *authenticate(credentials) {
                  return { sub: String(credentials['tenant']) }
                },
                *loadUser(sub) {
                  return { sub }
                },
              },
            }),
          ],
        })
        const info = yield* server.start({ port: 0 })
        const tokens = yield* Auth.actions.login({ tenant: 'a' })

        yield* seed('a', 'mine')
        yield* seed('b', 'theirs')

        const socket = new WebSocket(`${info.url!.replace('http', 'ws')}/notes/_realtime`)
        const frames: AnyType[] = []
        socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))

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
            socket.addEventListener('open', () => resolve())
          }),
        )

        // in-band auth first (tokens never travel in the URL), then a watch on EVERYTHING —
        // the scope narrows it to this subscriber's verified tenant
        socket.send(JSON.stringify({ t: 'auth', token: tokens.accessToken }))
        socket.send(JSON.stringify({ t: 'watch', id: 'w1' }))
        const sync = yield* next(0)
        expect(sync.t).toBe('sync')
        expect(sync.rows.map((row: AnyType) => row.title)).toEqual(['mine'])

        // another tenant's write never reaches this subscriber; its own does
        yield* seed('b', 'noise')
        yield* seed('a', 'fresh')
        const delta = yield* next(1)
        expect(delta.t).toBe('delta')
        expect(delta.added.map((row: AnyType) => row.title)).toEqual(['fresh'])

        socket.close()
        yield* server.stop()
      }),
    )
  })
})
