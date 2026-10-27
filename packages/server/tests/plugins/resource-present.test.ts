import { Server } from 'server:core'
import { crud } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage, todosTable } from '../helpers'

// `present(row, ctx)`: the stored row becomes the wire doc ONCE — for get, the mutations, each
// list row and every realtime frame; `after` sees the presented doc. `locals` is the bag the
// hooks of one call share.

describe('resource — present + locals', () => {
  it('projects every answered row, list pages and realtime frames; hooks share locals', async () => {
    const seen: string[] = []
    const todos = crud(todosTable, {
      schema: { doc: schema => schema.extend({ shout: z.string() }) },
      *present(row) {
        return { ...row, shout: row.title.toUpperCase() }
      },
      *before({ op, locals }) {
        locals['phase'] = `before:${op}`
      },
      *after({ op, locals, output }) {
        const doc = output as { shout?: string }

        seen.push(`${op}|${String(locals['phase'])}|${doc.shout ?? '-'}`)
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* Server.actions.create({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const created = (yield* server.call(todos, 'create', {
          title: 'open',
          done: false,
        })) as AnyType

        expect(created.shout).toBe('OPEN')

        const got = (yield* server.call(todos, 'get', { id: created._id })) as AnyType

        expect(got.shout).toBe('OPEN')

        const page = (yield* server.call(todos, 'list', {})) as AnyType

        expect(page.data.map((row: AnyType) => row.shout)).toEqual(['OPEN'])
        expect(seen).toEqual([
          'create|before:create|OPEN',
          'get|before:get|OPEN',
          'list|before:list|-',
        ])

        // the realtime frames carry presented rows too
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
        ws.send(JSON.stringify({ t: 'watch', id: 'w1' }))

        const sync = yield* next(0)

        expect(sync.t).toBe('sync')
        expect(sync.rows.map((row: AnyType) => row.shout)).toEqual(['OPEN'])

        yield* server.call(todos, 'create', { title: 'fresh', done: false })

        const delta = yield* next(1)

        expect(delta.t).toBe('delta')
        expect(delta.added.map((row: AnyType) => row.shout)).toEqual(['FRESH'])

        ws.close()
        yield* server.stop()
      }),
    )
  })
})
