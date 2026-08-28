/**
 * RUNNABLE crud ops: the built-in pipelines (`crud.list`, `crud.get`, …) as single calls inside
 * ANY handler — the custom action owns its route, schemas, errors and tags; the ops read the
 * dispatch ctx ambiently and behave exactly like the built-ins (sanitized filters, clamped
 * limits, ambient `If-Match`). `crud.realtime` is the delta-watch socket as an `action.socket`
 * entry of a custom service.
 */
import { CLEAR, DbClient, DbErrors, useDb, where } from 'db:core'
import { action, createServer, Edge, ServerErrors, service } from 'server:core'
import { crud, Docs } from 'server:plugins'
import { attempt, run, until } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
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

const send = (
  method: string,
  path: string,
  init?: { readonly body?: unknown; readonly headers?: Record<string, string> },
) =>
  json(path, {
    method,
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

/** A custom service over the todos table: every route/schema/error is the author's, the crud
 * mechanics are one `yield*` away. */
const catalogue = service('catalogue', {
  // the §00 shape the built-in list cannot carry: an author-owned envelope with `total`
  open: action.query(
    {
      input: crud.schemas.listInput,
      output: crud.schemas.page(todosTable).extend({ total: z.number() }),
      route: { method: 'GET', path: '/catalogue/open' },
      errors: crud.errors,
      description: 'Open todos only, with the set total',
    },
    function* ({ input }) {
      return yield* crud.list(todosTable, {
        input,
        scope: where.eq('done', false),
        total: true,
      })
    },
  ),

  peek: action.query(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ found: z.boolean() }),
      route: { method: 'GET', path: '/catalogue/peek/:id' },
    },
    function* ({ input }) {
      const row = yield* crud.get(todosTable, { id: input.id, optional: true })
      return { found: row !== null }
    },
  ),

  seed: action.mutation(
    {
      input: z.object({ title: z.string() }),
      output: crud.schemas.doc(todosTable),
      route: { method: 'POST', path: '/catalogue' },
      errors: crud.errors,
    },
    function* ({ input }) {
      return yield* crud.create(todosTable, { value: { title: input.title, done: false } })
    },
  ),

  rename: action.mutation(
    {
      input: z.object({ id: z.string(), title: z.string() }),
      output: crud.schemas.doc(todosTable),
      route: { method: 'PATCH', path: '/catalogue/:id' },
      errors: crud.errors,
    },
    function* ({ input }) {
      // no explicit `ifVersion`: the AMBIENT `If-Match` header gates the write (built-in parity)
      return yield* crud.update(todosTable, { id: input.id, patch: { title: input.title } })
    },
  ),

  drop: action.mutation(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ removed: z.boolean() }),
      route: { method: 'DELETE', path: '/catalogue/:id' },
      errors: crud.errors,
    },
    function* ({ input }) {
      return yield* crud.remove(todosTable, { id: input.id })
    },
  ),

  bulk: action.mutation(
    {
      input: z.object({ titles: z.array(z.string()) }),
      output: z.object({ created: z.number(), open: z.number() }),
      route: { method: 'POST', path: '/catalogue/bulk' },
      errors: crud.errors,
    },
    function* ({ input }) {
      // ops inside a TRANSACTION: the `db` override alone swaps the handle
      const rows = yield* (yield* useDb(todosTable)).transaction(tx =>
        crud.createMany(todosTable, {
          values: input.titles.map(title => ({ title, done: false })),
          db: tx,
        }),
      )

      return {
        created: rows.length,
        open: yield* crud.count(todosTable, { scope: where.eq('done', false) }),
      }
    },
  ),

  tally: action.query(
    {
      input: crud.schemas.listInput.pick({ filter: true }),
      output: z.object({ count: z.number() }),
      route: { method: 'GET', path: '/catalogue/tally' },
      errors: crud.errors,
    },
    function* ({ input }) {
      // the CLIENT's filter rides `crud.count` too: sanitized like `list`, AND-ed under scope
      return {
        count: yield* crud.count(todosTable, {
          filter: input.filter,
          scope: where.eq('done', false),
        }),
      }
    },
  ),

  purge: action.mutation(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ removed: z.boolean() }),
      route: { method: 'DELETE', path: '/catalogue/purge/:id' },
      errors: crud.errors,
    },
    function* ({ input }) {
      // strict: nothing removed is a FAILURE, not `{ removed: false }`
      return yield* crud.remove(todosTable, { id: input.id, strict: true })
    },
  ),
})

describe('resource — runnable ops', () => {
  it('power a custom action end to end (scope, total, ambient If-Match, optional get)', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [catalogue], edge: BunEdge })
        yield* server.start()

        const a = yield* send('POST', '/catalogue', { body: { title: 'alpha' } })
        expect(a.status).toBe(200)
        const b = yield* send('POST', '/catalogue', { body: { title: 'beta' } })

        // `scope` is AND-ed with the client filter; `total` counts the SCOPED set
        const open = yield* json('/catalogue/open')
        expect(open.status).toBe(200)
        expect(open.body.data.map((row: AnyType) => row.title).toSorted()).toEqual([
          'alpha',
          'beta',
        ])
        expect(open.body.total).toBe(2)

        const filtered = yield* json(
          `/catalogue/open?filter=${encodeURIComponent(
            JSON.stringify({ op: 'eq', field: 'title', value: 'beta' }),
          )}`,
        )
        expect(filtered.body.data.map((row: AnyType) => row.title)).toEqual(['beta'])
        expect(filtered.body.total).toBe(1)

        // the client filter goes through the SAME sanitizer as the built-in list
        const bad = yield* json(
          `/catalogue/open?filter=${encodeURIComponent(
            JSON.stringify({ op: 'eq', field: 'secret', value: 'x' }),
          )}`,
        )
        expect(bad.status).toBe(400)

        // ambient If-Match: a stale `_version` rejects with 412, the current one passes
        const stale = yield* send('PATCH', `/catalogue/${a.body._id}`, {
          body: { title: 'stale' },
          headers: { 'if-match': '"v:does-not-exist"' },
        })
        expect(stale.status).toBe(412)

        const renamed = yield* send('PATCH', `/catalogue/${a.body._id}`, {
          body: { title: 'ALPHA' },
          headers: { 'if-match': `"${a.body._version}"` },
        })
        expect(renamed.status).toBe(200)
        expect(renamed.body.title).toBe('ALPHA')

        // optional get: null instead of `server.not-found`
        expect((yield* json(`/catalogue/peek/${a.body._id}`)).body.found).toBe(true)
        expect((yield* json('/catalogue/peek/missing')).body.found).toBe(false)

        const dropped = yield* send('DELETE', `/catalogue/${b.body._id}`)
        expect(dropped.body.removed).toBe(true)
        expect((yield* json('/catalogue/open')).body.total).toBe(1)

        // createMany rides a transaction (`db: tx`), count sees the committed scoped set
        const bulk = yield* send('POST', '/catalogue/bulk', {
          body: { titles: ['bulk-1', 'bulk-2'] },
        })
        expect(bulk.status).toBe(200)
        expect(bulk.body).toEqual({ created: 2, open: 3 })

        // strict remove: a missing row is a 404
        expect((yield* send('DELETE', '/catalogue/purge/nope')).status).toBe(404)

        // crud.count with the CLIENT's filter: bare → the scoped set, a JSON-string filter
        // narrows it, and the SAME sanitizer rejects unknown fields
        expect((yield* json('/catalogue/tally')).body).toEqual({ count: 3 })

        const tallied = yield* json(
          `/catalogue/tally?filter=${encodeURIComponent(
            JSON.stringify({ op: 'eq', field: 'title', value: 'bulk-1' }),
          )}`,
        )
        expect(tallied.body).toEqual({ count: 1 })

        const refused = yield* json(
          `/catalogue/tally?filter=${encodeURIComponent(
            JSON.stringify({ op: 'eq', field: 'secret', value: 'x' }),
          )}`,
        )
        expect(refused.status).toBe(400)

        yield* server.stop()
      }),
    )
  })

  it('realtimePath moves the socket route; shapes expose the RESOLVED schemas', () => {
    const shaped = crud(todosTable, {
      realtimePath: '/live',
      schema: {
        *output(s, of) {
          if (of === 'page') {
            return s.extend({ total: z.number() })
          }
          return s
        },
      },
    })

    const entry = (shaped.actions as AnyType)._realtime
    expect(entry.socket.path).toBe('/todos/live')
    expect(entry.socket.protocol).toBe('resource')
    expect(entry.socket.defaults).toEqual({ cursor: 0 })

    // `shapes` carries what the schema hooks produced — extend actions reuse THESE instead
    // of re-deriving raw table shapes
    expect(Object.keys(shaped.shapes.page.shape)).toContain('total')
    expect(Object.keys(shaped.shapes.doc.shape)).toContain('title')
    expect(Object.keys(shaped.shapes.update.shape)).toContain('id')
  })

  it('read the dispatch ctx ambiently — outside one they name the fix', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const outcome = yield* attempt(() => crud.list(todosTable))
        expect(isFailure(outcome)).toBe(true)
        expect((outcome as AnyType).error).toBe(ServerErrors.Configuration)
      }),
    )
  })

  it('a `db` override runs the ops with no dispatch at all (scripts, start hooks)', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const db = (yield* DbClient.context.get()) as AnyType

        // no dispatch, no ctx anywhere — the handle alone is enough (spans simply skip)
        const rows = (yield* crud.createMany(todosTable, {
          values: [
            { title: 'seed-a', done: false },
            { title: 'seed-b', done: true },
          ],
          db,
        })) as AnyType
        expect(rows).toHaveLength(2)

        // no request → no `If-Match` → an un-pinned update passes (no version gate)
        const renamed = (yield* crud.update(todosTable, {
          id: rows[0]._id,
          patch: { title: 'seed-A' },
          db,
        })) as AnyType
        expect(renamed.title).toBe('seed-A')

        // an explicit `ifVersion` still gates — a stale pin conflicts even without a request
        const stale = yield* attempt(() =>
          crud.update(todosTable, {
            id: rows[0]._id,
            patch: { title: 'nope' },
            ifVersion: 'v:stale',
            db,
          }),
        )
        expect(isFailure(stale)).toBe(true)
        expect(String((stale as AnyType).error)).toBe(DbErrors.Conflict)

        // reads count the same way
        expect(yield* crud.count(todosTable, { scope: where.eq('done', false), db })).toBe(1)
      }),
    )
  })

  it('crud.update takes CLEAR to null an optional column, exactly like db.patch', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const db = (yield* DbClient.context.get()) as AnyType

        const row = (yield* crud.create(todosTable, {
          value: { title: 'noted', done: false, note: 'temporary' },
          db,
        })) as AnyType
        expect(row.note).toBe('temporary')

        // compiling is the point: the typed op's patch is aligned with db's `PatchOf`
        const cleared = (yield* crud.update(todosTable, {
          id: String(row._id),
          patch: { note: CLEAR },
          db,
        })) as AnyType
        expect(cleared.note).toBeNull()
      }),
    )
  })

  it('crud.realtime mounts the delta-watch socket inside a custom service', async () => {
    const frames: AnyType[] = []

    const nextFrame = (after: number): Promise<AnyType> =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (frames.length > after) {
            resolve(frames[after])
            return
          }
          if (Date.now() > deadline) {
            reject(new Error(`no frame ${after} — got ${JSON.stringify(frames)}`))
            return
          }
          setTimeout(poll, 10)
        }
        poll()
      })

    unwrap(
      await run(function* () {
        yield* storage()

        const feed = service('feed', {
          board: crud.realtime(todosTable, {
            // 'title' is NOT filterable, yet the trusted scope filters by it: it joins AFTER
            // the sanitizer, so tenancy fields never open up to client filtering
            filterable: ['done'],
            *scope() {
              return where.ne('title', 'hidden')
            },
            hooks: {
              // the after hook PROJECTS outgoing rows — here down to a shouted title
              *after({ output }) {
                const frame = output as AnyType
                if (frame.t !== 'sync') {
                  return
                }
                return {
                  ...frame,
                  rows: frame.rows.map((row: AnyType) => ({
                    _id: row._id,
                    title: String(row.title).toUpperCase(),
                  })),
                }
              },
            },
          }),
        })

        const server = yield* createServer({
          services: [catalogue, feed],
          edge: BunEdge,
          plugins: [Docs.use({ path: '/docs' })],
        })
        const info = yield* server.start({ port: 0 })
        const base = info.url!

        // the socket lives under the CUSTOM service in the manifest, defaults included
        const manifest = (yield* until(
          (yield* until(fetch(`${base}/docs/manifest`))).json(),
        )) as AnyType
        const socketDoc = manifest.sockets.find((entry: AnyType) => entry.path === '/feed/board')
        expect(socketDoc).toMatchObject({
          service: 'feed',
          protocol: 'resource',
          defaults: { cursor: 0 },
        })

        for (const title of ['live', 'hidden']) {
          yield* until(
            fetch(`${base}/catalogue`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title }),
            }),
          )
        }

        const ws = new WebSocket(`${base.replace('http', 'ws')}/feed/board`)
        ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
        yield* until(
          new Promise(resolve => {
            ws.addEventListener('open', resolve)
          }),
        )

        ws.send(JSON.stringify({ t: 'watch', id: 'w' }))
        const sync = yield* until(nextFrame(0))
        expect(sync.t).toBe('sync')
        expect(sync.rows.map((row: AnyType) => row.title)).toEqual(['LIVE'])

        ws.close()
        yield* server.stop()
      }),
    )
  }, 20_000)
})
