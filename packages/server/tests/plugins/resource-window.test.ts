/**
 * WINDOWED realtime: `watch { limit, cursor }` subscribes ONE keyset page — in-window changes
 * arrive as `delta`, set changes around an untouched window as `notify` (another client's write
 * moved the range/total), and re-watching the same id with a new cursor turns the page for that
 * subscriber only. Every frame carries the page token (uniform version tracking).
 */
import { createServer } from 'server:core'
import { crud, Docs } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todosTable } from '../helpers'

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

describe('resource — windowed realtime', () => {
  it('sync page → in-window delta → out-of-window notify → page turn', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const todos = crud(todosTable)
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Docs.use({ path: '/docs' })],
        })
        const info = yield* server.start({ port: 0 })
        const base = info.url!

        // the manifest documents the realtime opening defaults: cursor 0 = start of the set
        const manifest = (yield* until(
          (yield* until(fetch(`${base}/docs/manifest`))).json(),
        )) as AnyType
        const socketDoc = manifest.services
          .flatMap((svc: AnyType) => svc.actions)
          .find((entry: AnyType) => entry.kind === 'socket' && entry.protocol === 'resource')
        expect(socketDoc).toMatchObject({ path: '/todos/_realtime', defaults: { cursor: 0 } })

        const create = (title: string) =>
          until(
            fetch(`${base}/todos`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title, done: false }),
            }),
          )

        for (const title of ['a', 'b', 'c', 'd', 'e']) {
          yield* create(title)
        }

        const ws = new WebSocket(`${base.replace('http', 'ws')}/todos/_realtime`)
        ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
        yield* until(
          new Promise(resolve => {
            ws.addEventListener('open', resolve)
          }),
        )

        // window 1: the first two titles — cursor 0 (the manifest default) is the start
        ws.send(
          JSON.stringify({ t: 'watch', id: 'w', limit: 2, cursor: 0, order: { field: 'title' } }),
        )
        const sync = yield* until(nextFrame(0))
        expect(sync.t).toBe('sync')
        expect(sync.rows.map((row: AnyType) => row.title)).toEqual(['a', 'b'])
        expect(sync.page).toMatchObject({ prev: null, total: 5 })
        expect(sync.page.next).toBeTruthy()
        expect(typeof sync.token).toBe('string')

        // an IN-WINDOW change (order untouched) → delta.changed
        const aId = sync.rows[0]._id
        yield* until(
          fetch(`${base}/todos/${aId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ done: true }),
          }),
        )
        const delta1 = yield* until(nextFrame(1))
        expect(delta1.t).toBe('delta')
        expect(delta1.changed.map((row: AnyType) => row.title)).toEqual(['a'])
        expect(delta1.page.total).toBe(5)
        expect(delta1.token > sync.token).toBe(true)

        // an OUT-OF-WINDOW insert ("another client created a row past your range") → notify
        yield* create('x')
        const notify = yield* until(nextFrame(2))
        expect(notify.t).toBe('notify')
        expect(notify.page.total).toBe(6)
        expect(notify.token > delta1.token).toBe(true)

        // an insert that SHIFTS the window ('A' sorts first) → delta: added A, removed b
        yield* create('A')
        const delta2 = yield* until(nextFrame(3))
        expect(delta2.t).toBe('delta')
        expect(delta2.added.map((row: AnyType) => row.title)).toEqual(['A'])
        expect(delta2.removed).toHaveLength(1)
        expect(delta2.page.total).toBe(7)

        // PAGE TURN: same id, next cursor — replaces THIS subscriber's window only
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w',
            limit: 2,
            cursor: delta2.page.next,
            order: { field: 'title' },
          }),
        )
        const sync2 = yield* until(nextFrame(4))
        expect(sync2.t).toBe('sync')
        expect(sync2.rows.map((row: AnyType) => row.title)).toEqual(['b', 'c'])
        expect(sync2.page.prev).toBeTruthy()

        // and BACK: the prev cursor pages backward to the original window
        ws.send(
          JSON.stringify({
            t: 'watch',
            id: 'w',
            limit: 2,
            cursor: sync2.page.prev,
            back: true,
            order: { field: 'title' },
          }),
        )
        const sync3 = yield* until(nextFrame(5))
        expect(sync3.t).toBe('sync')
        expect(sync3.rows.map((row: AnyType) => row.title)).toEqual(['A', 'a'])

        // a bare row _id as cursor: the window STARTS at that row (default `_id` order)
        const all = yield* until((yield* until(fetch(`${base}/todos?order=_id`))).json())
        const third = (all as AnyType).data[2]
        ws.send(JSON.stringify({ t: 'watch', id: 'row', limit: 2, cursor: third._id }))
        const fromRow = yield* until(nextFrame(6))
        expect(fromRow.t).toBe('sync')
        expect(fromRow.rows[0]._id).toBe(third._id)

        // an unreadable cursor no longer dies silently — it comes back as an error frame
        ws.send(JSON.stringify({ t: 'watch', id: 'bad', limit: 2, cursor: '???' }))
        const bad = yield* until(nextFrame(7))
        expect(bad).toMatchObject({ t: 'error', id: 'bad', tag: 'db.cursor' })

        ws.close()
        yield* server.stop()
      }),
    )
  }, 20_000)
})
