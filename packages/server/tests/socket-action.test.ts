/**
 * `action.socket`: a socket declared INSIDE a service — default `/<service>/<action>` path,
 * mounted by the edge with everything else, listed under the service in the manifest, absent
 * from the callable api. `receives`/`sends` type the handler; `receives` also validates the
 * wire, dropping a malformed frame instead of killing the session.
 */
import { action, createServer, service } from 'server:core'
import type { DocsDef } from 'server:plugins'
import { Docs } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from './helpers'

const echo = service('echo', {
  ping: action.query({ output: z.object({ pong: z.boolean() }) }, function* () {
    return { pong: true }
  }),
  room: action.socket(
    {
      protocol: 'chat',
      description: 'echoes every frame back, uppercased',
      receives: z.object({ text: z.string() }),

      sends: z.union([
        z.object({ t: z.literal('hello'), who: z.string().nullable() }),
        z.object({ t: z.literal('echo'), text: z.string() }),
      ]),
    },
    function* (socket) {
      // the upgrade url travels onto the socket — query params included
      yield* socket.send({ t: 'hello', who: socket.url.searchParams.get('who') })
      const messages = yield* socket.messages

      for (;;) {
        const step = yield* messages.next()

        if (step.done) {
          return
        }

        // `step.value` is typed by `receives` — no cast, no defensive coercion
        yield* socket.send({ t: 'echo', text: step.value.text.toUpperCase() })
      }
    },
  ),
})

describe('action.socket', () => {
  it('mounts at /<service>/<action>, talks, and stays out of the callable api', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [echo], edge: BunEdge, plugins: [Docs] })
        const info = yield* server.start({ port: 0 })

        // the manifest lists it under the service
        const manifest = yield* server.manifest()
        expect(manifest.actions.map(entry => `${entry.service}.${entry.action}`)).toEqual([
          'echo.ping',
        ])

        // the socket is not a callable action
        expect('room' in (server.api.echo as Record<string, unknown>)).toBe(false)

        // it talks
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/echo/room?who=ada`)
        const frames: string[] = []

        yield* until(
          new Promise<void>((resolve, reject) => {
            ws.addEventListener('message', event => {
              frames.push(String(event.data))

              if (frames.length === 1) {
                ws.send(JSON.stringify({ text: 'hi there' }))
              }

              if (frames.length === 2) {
                ws.close()
                resolve()
              }
            })
            ws.addEventListener('error', () => reject(new Error('socket error')))
          }),
        )

        expect(JSON.parse(frames[0]!)).toEqual({ t: 'hello', who: 'ada' })
        expect(JSON.parse(frames[1]!)).toEqual({ t: 'echo', text: 'HI THERE' })

        // the manifest publishes what the socket speaks — a UNIFIED service entry in v2
        const published = yield* Docs.actions.manifest()
        const socketDoc = published.services
          .flatMap(svc => svc.actions)
          .find((entry): entry is DocsDef.SocketDoc => entry.kind === 'socket')
        expect(socketDoc).toMatchObject({ path: '/echo/room', protocol: 'chat' })
        expect((socketDoc?.receives as AnyType)?.properties?.text?.type).toBe('string')
        expect(socketDoc?.sends).not.toBe(null)

        yield* server.stop()
      }),
    )
  })
})

describe('action.socket — receives', () => {
  it('drops a malformed frame and keeps the session alive', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [echo], edge: BunEdge })
        const info = yield* server.start({ port: 0 })

        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/echo/room?who=bob`)
        const frames: string[] = []

        yield* until(
          new Promise<void>((resolve, reject) => {
            ws.addEventListener('message', event => {
              frames.push(String(event.data))

              if (frames.length === 1) {
                // `text` must be a string: this frame never reaches the handler
                ws.send(JSON.stringify({ text: 42 }))
                ws.send(JSON.stringify({ nope: true }))
                // …and the session is still good for a valid one
                ws.send(JSON.stringify({ text: 'still here' }))
              }

              if (frames.length === 2) {
                ws.close()
                resolve()
              }
            })
            ws.addEventListener('error', () => reject(new Error('socket error')))
          }),
        )

        expect(JSON.parse(frames[1]!)).toEqual({ t: 'echo', text: 'STILL HERE' })
        yield* server.stop()
      }),
    )
  })
})
